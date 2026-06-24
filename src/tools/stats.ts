import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { getStats } from "../db.js";

// === 注册工具 ===

export function registerStatsTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_stats",
    {
      description:
        "查看技术知识库的统计信息，包括总条目数、总关联数、按分类/项目分布、数据库文件大小及最后更新时间。",
      inputSchema: z.strictObject({}),
    },
    async () => {
      const stats = getStats(db);

      process.stderr.write(
        `[tech-memory] tech_stats requested (total_entries=${stats.total_entries})\n`
      );

      // 格式化数据库大小
      const sizeStr =
        stats.db_size_bytes > 0
          ? stats.db_size_bytes >= 1024 * 1024
            ? `${(stats.db_size_bytes / (1024 * 1024)).toFixed(2)} MB`
            : `${(stats.db_size_bytes / 1024).toFixed(1)} KB`
          : "N/A（内存数据库）";

      // 构建人类可读摘要
      const summaryLines = [
        "=== 技术知识库统计 ===",
        "",
        `总条目数:    ${stats.total_entries}`,
        `总关联数:    ${stats.total_edges}`,
        "",
        "--- 按分类分布 ---",
        ...(Object.keys(stats.by_category).length > 0
          ? Object.entries(stats.by_category)
              .sort((a, b) => b[1] - a[1])
              .map(([cat, count]) => {
                const label: Record<string, string> = {
                  decision: "技术决策",
                  lesson: "经验教训",
                  preference: "个人偏好",
                  fact: "技术事实",
                  pattern: "通用模式",
                };
                return `  ${label[cat] ?? cat} (${cat}): ${count}`;
              })
          : ["  (暂无数据)"]),
        "",
        "--- 按项目分布 ---",
        ...(Object.keys(stats.by_project).length > 0
          ? Object.entries(stats.by_project)
              .sort((a, b) => b[1] - a[1])
              .map(([proj, count]) => `  ${proj}: ${count}`)
          : ["  (暂无数据)"]),
        "",
        `数据库大小:  ${sizeStr}`,
        `最后更新:    ${stats.last_updated ?? "从未"}`,
        "",
        "=== 原始数据 (JSON) ===",
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text:
              summaryLines +
              "\n" +
              JSON.stringify(stats, null, 2),
          },
        ],
      };
    }
  );
}
