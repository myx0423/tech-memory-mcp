import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import type { KnowledgeEntry, KnowledgeCategory } from "../types.js";

function log(msg: string) {
  process.stderr.write(`[tech_outdated] ${msg}\n`);
}

export function registerOutdatedTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_outdated",
    {
      description:
        "查询过期或低置信度的知识点，供用户复审或删除。可过滤已标记过期的条目（is_outdated=1）" +
        "或置信度低于 0.3 的条目，以及超过指定天数未被确认的条目。",
      inputSchema: z
        .object({
          category: z
            .enum(["decision", "lesson", "preference", "fact", "pattern"])
            .optional()
            .describe("按知识类型过滤"),
          min_days_since_confirmed: z
            .number()
            .int()
            .min(0)
            .optional()
            .default(90)
            .describe("超过多少天未被确认的条目（默认 90 天）"),
          include_low_confidence: z
            .boolean()
            .optional()
            .default(true)
            .describe("是否包含置信度低于 0.3 的条目（默认 true）"),
          include_expired: z
            .boolean()
            .optional()
            .default(true)
            .describe("是否包含已标记过期的条目（默认 true）"),
        })
        .strict(),
    },
    async (params) => {
      const { category, min_days_since_confirmed = 90, include_low_confidence = true, include_expired = true } = params;

      log(`查询过期知识：category=${category ?? "全部"} min_days=${min_days_since_confirmed}`);

      try {
        const conditions: string[] = [];
        const queryParams: any[] = [];

        // 已标记过期的条目
        if (include_expired) {
          conditions.push("is_outdated = 1");
        }

        // 低置信度条目
        if (include_low_confidence) {
          conditions.push("confidence < 0.3");
        }

        // 超过指定天数未被确认
        if (min_days_since_confirmed > 0) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - min_days_since_confirmed);
          const cutoffISO = cutoffDate.toISOString();

          conditions.push(
            "(last_confirmed_at IS NULL AND created_at < ?) OR (last_confirmed_at IS NOT NULL AND last_confirmed_at < ?)"
          );
          queryParams.push(cutoffISO, cutoffISO);
        }

        // 按类型过滤
        if (category) {
          conditions.push("category = ?");
          queryParams.push(category);
        }

        if (conditions.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  items: [],
                  total: 0,
                  message: "未设置任何过滤条件",
                }),
              },
            ],
          };
        }

        const whereClause = conditions.join(" OR ");
        const query = `SELECT * FROM knowledge WHERE ${whereClause} ORDER BY confidence ASC, updated_at ASC`;

        const rows = db.prepare(query).all(...queryParams) as any[];
        const items = rows.map(rowToEntry);

        log(`找到 ${items.length} 条过期或低置信度知识`);

        const categoryCounts: Record<string, number> = {};
        for (const item of items) {
          categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
        }

        const summary = Object.entries(categoryCounts)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");

        const message = `🔍 找到 ${items.length} 条过期或低置信度知识（${summary || "无"}）\n\n` +
          `建议操作：\n` +
          `1. 复审内容，确认是否仍然有效\n` +
          `2. 使用 tech_confirm 工具确认有用的条目\n` +
          `3. 删除过时或无用的条目`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  items,
                  total: items.length,
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
        log(`查询失败：${errMsg}`);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ 查询过期知识失败：${errMsg}`,
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
    category: row.category as KnowledgeCategory,
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
