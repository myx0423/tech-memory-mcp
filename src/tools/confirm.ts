import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { getKnowledge, updateKnowledge, recordAdoption, recordRejection } from "../db.js";

function log(msg: string) {
  process.stderr.write(`[tech_confirm] ${msg}\n`);
}

export function registerConfirmTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_confirm",
    {
      description:
        "确认知识点是否有用。每次确认会调整置信度：有用则增加（最多到 1.0），无用则减少（最少到 0.1）。" +
        "同时更新确认次数和最后确认时间。",
      inputSchema: z
        .object({
          id: z
            .string()
            .min(1, "知识点 ID 不能为空")
            .describe("知识点 ID"),
          useful: z
            .boolean()
            .describe("是否有用：true=增加置信度，false=减少置信度"),
          note: z
            .string()
            .optional()
            .describe("补充说明（可选）"),
          query: z
            .string()
            .optional()
            .describe("查询场景：记录是在什么查询场景下采用的（可选）"),
        })
        .strict(),
    },
    async (params) => {
      const { id, useful, note, query } = params;

      log(`确认知识点：id=${id} useful=${useful}`);

      try {
        const entry = getKnowledge(db, id);
        if (!entry) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `❌ 未找到知识点：${id}`,
              },
            ],
          };
        }

        let newConfidence = entry.confidence;
        let newConfirmedCount = entry.confirmed_count;
        const now = new Date().toISOString();

        if (useful) {
          // confidence = min(1.0, confidence + 0.05 * (1 - confidence))
          newConfidence = Math.min(1.0, entry.confidence + 0.05 * (1 - entry.confidence));
          newConfirmedCount = entry.confirmed_count + 1;
          log(`置信度增加：${entry.confidence.toFixed(3)} → ${newConfidence.toFixed(3)}`);
        } else {
          // confidence = max(0.1, confidence - 0.1)
          newConfidence = Math.max(0.1, entry.confidence - 0.1);
          log(`置信度减少：${entry.confidence.toFixed(3)} → ${newConfidence.toFixed(3)}`);
        }

        // 更新数据库
        db.prepare(`
          UPDATE knowledge
          SET confidence = ?, confirmed_count = ?, last_confirmed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(newConfidence, newConfirmedCount, now, now, id);

        // 记录采用/拒绝事件
        if (useful) {
          recordAdoption(db, id, query ?? null);
          log(`已记录采用事件：knowledge_id=${id}, query=${query ?? "未指定"}`);
        } else {
          recordRejection(db, id, query ?? null);
          log(`已记录拒绝事件：knowledge_id=${id}, query=${query ?? "未指定"}`);
        }

        const updated = getKnowledge(db, id);
        if (!updated) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `❌ 更新后未找到知识点：${id}`,
              },
            ],
          };
        }

        const action = useful ? "增加" : "减少";
        const message = `✅ 已确认知识点（置信度${action}）\n\n` +
          `**ID**：\`${updated.id}\`\n` +
          `**置信度**：${updated.confidence.toFixed(3)}\n` +
          `**确认次数**：${updated.confirmed_count}\n` +
          `**最后确认**：${updated.last_confirmed_at ?? "无"}` +
          (note ? `\n**备注**：${note}` : "");

        log(`确认完成：confidence=${updated.confidence.toFixed(3)} confirmed_count=${updated.confirmed_count}`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  entry: updated,
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
        log(`确认失败：${errMsg}`);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ 确认知识点失败：${errMsg}`,
            },
          ],
        };
      }
    }
  );
}
