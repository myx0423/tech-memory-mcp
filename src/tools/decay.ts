import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { getKnowledge, cleanupOldUsageEvents } from "../db.js";
import type { KnowledgeEntry } from "../types.js";

function log(msg: string) {
  process.stderr.write(`[tech_decay] ${msg}\n`);
}

export function registerDecayTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_decay",
    {
      description:
        "执行知识老化衰减。对所有知识点批量处理：根据衰减速率和时间计算新的置信度，" +
        "低于 0.3 的标记为过期。支持 dry_run 模式预览影响范围。",
      inputSchema: z
        .object({
          dry_run: z
            .boolean()
            .optional()
            .default(false)
            .describe("预览模式：只返回将受影响的条目列表，不实际修改"),
        })
        .strict(),
    },
    async (params) => {
      const { dry_run } = params;

      log(`执行老化衰减：dry_run=${dry_run}`);

      try {
        // 获取所有知识点
        const allEntries = db.prepare("SELECT * FROM knowledge").all() as any[];
        log(`共 ${allEntries.length} 条知识点需要处理`);

        const now = Date.now();
        let processed = 0;
        let markedOutdated = 0;
        let totalConfidenceBefore = 0;
        let totalConfidenceAfter = 0;
        const itemsAffected: KnowledgeEntry[] = [];

        for (const row of allEntries) {
          const entry = rowToEntry(row);
          const confidenceBefore = entry.confidence;
          totalConfidenceBefore += confidenceBefore;

          // 计算距上次确认或创建的天数
          const referenceTime = entry.last_confirmed_at
            ? new Date(entry.last_confirmed_at).getTime()
            : new Date(entry.created_at).getTime();
          const daysElapsed = (now - referenceTime) / (1000 * 60 * 60 * 24);

          // 衰减公式：new_confidence = confidence * e^(-decay_rate * days_elapsed)
          let newConfidence = entry.confidence * Math.exp(-entry.decay_rate * daysElapsed);
          newConfidence = Math.max(0, Math.min(1, newConfidence));

          // 检查是否过期
          let isOutdated = entry.is_outdated;
          if (entry.expires_at) {
            const expiresTime = new Date(entry.expires_at).getTime();
            if (now > expiresTime) {
              isOutdated = 1;
              log(`知识点 ${entry.id} 已过期（expires_at=${entry.expires_at}）`);
            }
          }

          // 如果新置信度低于 0.3，标记为过期
          if (newConfidence < 0.3) {
            isOutdated = 1;
            log(`知识点 ${entry.id} 置信度过低（${newConfidence.toFixed(3)} < 0.3），标记为过期`);
          }

          const confidenceChanged = Math.abs(newConfidence - confidenceBefore) > 0.001;
          const outdatedChanged = isOutdated !== entry.is_outdated;

          if (confidenceChanged || outdatedChanged) {
            processed++;
            totalConfidenceAfter += newConfidence;

            if (isOutdated === 1 && entry.is_outdated === 0) {
              markedOutdated++;
            }

            if (!dry_run) {
              // 实际更新数据库
              db.prepare(`
                UPDATE knowledge
                SET confidence = ?, is_outdated = ?, updated_at = ?
                WHERE id = ?
              `).run(newConfidence, isOutdated, new Date().toISOString(), entry.id);
            }

            // 记录受影响的条目
            const updatedEntry: KnowledgeEntry = {
              ...entry,
              confidence: newConfidence,
              is_outdated: isOutdated,
              updated_at: new Date().toISOString(),
            };
            itemsAffected.push(updatedEntry);

            log(
              `知识点 ${entry.id}: confidence ${confidenceBefore.toFixed(3)} → ${newConfidence.toFixed(3)}, ` +
              `is_outdated ${entry.is_outdated} → ${isOutdated}`
            );
          } else {
            totalConfidenceAfter += confidenceBefore;
          }
        }

        const avgConfidenceBefore = allEntries.length > 0 ? totalConfidenceBefore / allEntries.length : 0;
        const avgConfidenceAfter = allEntries.length > 0 ? totalConfidenceAfter / allEntries.length : 0;

        // 清理超过 90 天的 usage_events
        let eventsCleaned = 0;
        if (!dry_run) {
          eventsCleaned = cleanupOldUsageEvents(db, 90);
          if (eventsCleaned > 0) {
            log(`已清理 ${eventsCleaned} 条过期 usage_events（>90 天）`);
          }
        }

        const message = dry_run
          ? `🔍 预览模式：将处理 ${processed} 条知识点，标记 ${markedOutdated} 条为过期`
          : `✅ 老化衰减完成：处理 ${processed} 条，标记 ${markedOutdated} 条为过期` +
            (eventsCleaned > 0 ? `，清理 ${eventsCleaned} 条过期使用事件` : "");

        log(`${message}`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  processed,
                  marked_outdated: markedOutdated,
                  events_cleaned: eventsCleaned,
                  average_confidence_before: avgConfidenceBefore,
                  average_confidence_after: avgConfidenceAfter,
                  items_affected: itemsAffected,
                  message,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`老化衰减失败：${errMsg}`);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ 老化衰减失败：${errMsg}`,
            },
          ],
        };
      }
    }
  );
}

function rowToEntry(row: any): KnowledgeEntry {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    tags: JSON.parse(row.tags || "[]"),
    source_conversation: row.source_conversation ?? undefined,
    project: row.project ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    access_count: row.access_count ?? 0,
    importance: row.importance ?? 0.5,
    confidence: row.confidence ?? 0.7,
    confirmed_count: row.confirmed_count ?? 0,
    decay_rate: row.decay_rate ?? 0.02,
    last_confirmed_at: row.last_confirmed_at ?? null,
    expires_at: row.expires_at ?? null,
    is_outdated: row.is_outdated ?? 0,
    impression_count: row.impression_count ?? 0,
    adoption_count: row.adoption_count ?? 0,
    last_impression_at: row.last_impression_at ?? null,
  };
}
