import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { getUsageStats } from "../db.js";

function log(msg: string) {
  process.stderr.write(`[tech_usage_stats] ${msg}\n`);
}

export function registerUsageStatsTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_usage_stats",
    {
      description:
        "返回知识库使用统计，包括曝光次数、采用次数、整体采用率、采用率最高的知识点、" +
        "曝光超过 5 次但从未被采用的知识点、以及最频繁的搜索词。",
      inputSchema: z
        .object({
          days: z
            .number()
            .int("天数必须为整数")
            .min(1, "天数不能小于 1")
            .max(365, "天数不能超过 365")
            .optional()
            .default(30)
            .describe("统计最近多少天的数据，默认 30 天"),
          top_n: z
            .number()
            .int("数量必须为整数")
            .min(1, "数量不能小于 1")
            .max(50, "数量不能超过 50")
            .optional()
            .default(10)
            .describe("返回 top_n 条采用率最高和最频繁的搜索词，默认 10 条"),
        })
        .strict(),
    },
    async (params) => {
      const { days, top_n } = params;

      log(`查询使用统计：days=${days} top_n=${top_n}`);

      try {
        const stats = getUsageStats(db, days, top_n);

        const message =
          `📊 知识库使用统计（最近 ${days} 天）\n\n` +
          `**总曝光次数**：${stats.total_impressions}\n` +
          `**总采用次数**：${stats.total_adoptions}\n` +
          `**整体采用率**：${(stats.overall_adoption_rate * 100).toFixed(2)}%\n\n` +
          `**采用率最高的 ${stats.top_adopted.length} 条知识**：\n` +
          (stats.top_adopted.length > 0
            ? stats.top_adopted
                .map((entry, idx) => {
                  const adoptionRate = entry.adoption_count / Math.max(entry.impression_count, 1);
                  return `${idx + 1}. [采用率 ${(adoptionRate * 100).toFixed(1)}%] ${entry.content.slice(0, 50)}... (曝光 ${entry.impression_count} 次, 采用 ${entry.adoption_count} 次)`;
                })
                .join("\n")
            : "  (暂无数据)") +
          "\n\n" +
          `**曝光超过 5 次但从未被采用的 ${stats.never_adopted.length} 条知识**：\n` +
          (stats.never_adopted.length > 0
            ? stats.never_adopted
                .map((entry, idx) => {
                  return `${idx + 1}. [曝光 ${entry.impression_count} 次] ${entry.content.slice(0, 50)}...`;
                })
                .join("\n")
            : "  (暂无数据)") +
          "\n\n" +
          `**最频繁的 ${stats.top_queries.length} 个搜索词**：\n` +
          (stats.top_queries.length > 0
            ? stats.top_queries
                .map((q, idx) => `${idx + 1}. "${q.query}" (${q.count} 次)`)
                .join("\n")
            : "  (暂无数据)");

        log(`统计完成：impressions=${stats.total_impressions} adoptions=${stats.total_adoptions}`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ...stats,
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
        log(`查询使用统计失败：${errMsg}`);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ 查询使用统计失败：${errMsg}`,
            },
          ],
        };
      }
    }
  );
}
