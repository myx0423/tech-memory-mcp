import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { KnowledgeEntry, KnowledgeCategory } from "../types.js";

function log(msg: string) {
  process.stderr.write(`[tech_export] ${msg}\n`);
}

// 查询符合条件的知识点
function queryEntries(
  db: Database,
  type?: string,
  project?: string,
  min_confidence: number = 0.0,
  include_outdated: boolean = false
): KnowledgeEntry[] {
  const conditions: string[] = [];
  const params: any[] = [];

  if (type) {
    conditions.push("category = ?");
    params.push(type);
  }

  if (project) {
    conditions.push("project = ?");
    params.push(project);
  }

  if (min_confidence > 0) {
    conditions.push("confidence >= ?");
    params.push(min_confidence);
  }

  if (!include_outdated) {
    conditions.push("is_outdated = 0");
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM knowledge ${whereClause} ORDER BY category, created_at DESC`;

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToEntry);
}

// 行数据转换为 KnowledgeEntry
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

// 导出为 Markdown 格式
function exportToMarkdown(entries: KnowledgeEntry[]): string {
  const now = new Date().toISOString();
  const lines: string[] = [];

  lines.push(`# 技术知识导出`);
  lines.push(``);
  lines.push(`**导出时间**: ${now}`);
  lines.push(`**总条目数**: ${entries.length}`);
  lines.push(``);

  // 按类型分组
  const grouped = new Map<string, KnowledgeEntry[]>();
  for (const entry of entries) {
    const category = entry.category;
    if (!grouped.has(category)) {
      grouped.set(category, []);
    }
    grouped.get(category)!.push(entry);
  }

  // 按类型输出
  const categoryLabels: Record<string, string> = {
    decision: "技术决策",
    lesson: "经验教训",
    preference: "个人偏好",
    fact: "技术事实",
    pattern: "通用模式",
  };

  for (const [category, categoryEntries] of grouped) {
    const label = categoryLabels[category] || category;
    lines.push(`## ${category} (${label})`);
    lines.push(``);

    for (const entry of categoryEntries) {
      lines.push(`### ${entry.id}`);
      lines.push(``);

      if (entry.project) {
        lines.push(`**项目**: ${entry.project}`);
        lines.push(``);
      }

      lines.push(`**置信度**: ${entry.confidence.toFixed(2)}`);
      lines.push(``);

      if (entry.tags.length > 0) {
        lines.push(`**标签**: ${entry.tags.join(", ")}`);
        lines.push(``);
      }

      lines.push(`**创建时间**: ${entry.created_at}`);
      lines.push(``);

      lines.push(entry.content);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }
  }

  return lines.join("\n");
}

// 导出为 JSON 格式
function exportToJSON(entries: KnowledgeEntry[]): string {
  // 排除向量数据，只保留知识点元数据
  const exportData = entries.map((entry) => ({
    id: entry.id,
    content: entry.content,
    category: entry.category,
    tags: entry.tags,
    source_conversation: entry.source_conversation,
    project: entry.project,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    access_count: entry.access_count,
    importance: entry.importance,
    confidence: entry.confidence,
    confirmed_count: entry.confirmed_count,
    decay_rate: entry.decay_rate,
    last_confirmed_at: entry.last_confirmed_at,
    expires_at: entry.expires_at,
    is_outdated: entry.is_outdated,
  }));

  return JSON.stringify(exportData, null, 2);
}

export function registerExportTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_export",
    {
      description:
        "导出技术知识库为 Markdown 或 JSON 格式。支持按类型、项目过滤，可设置最低置信度阈值。" +
        "Markdown 格式适合人类阅读和文档归档，JSON 格式适合数据备份和程序化处理。",
      inputSchema: z
        .object({
          format: z
            .enum(["markdown", "json"])
            .optional()
            .default("markdown")
            .describe("导出格式：markdown（人类可读）或 json（程序化处理），默认 markdown"),
          output_path: z
            .string()
            .optional()
            .describe("输出文件路径（可选）。不指定则返回内容字符串，指定则写入文件"),
          type: z
            .enum(["decision", "lesson", "preference", "fact", "pattern"])
            .optional()
            .describe("只导出指定类型的知识点（可选）"),
          project: z
            .string()
            .optional()
            .describe("只导出指定项目的知识点（可选）"),
          min_confidence: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .default(0.0)
            .describe("最低置信度阈值，过滤低于此值的知识点，默认 0.0"),
          include_outdated: z
            .boolean()
            .optional()
            .default(false)
            .describe("是否包含已过期的知识点，默认 false"),
        })
        .strict(),
    },
    async (params) => {
      const {
        format = "markdown",
        output_path,
        type,
        project,
        min_confidence = 0.0,
        include_outdated = false,
      } = params;

      log(
        `开始导出：format=${format} type=${type ?? "全部"} project=${project ?? "全部"} min_confidence=${min_confidence} include_outdated=${include_outdated}`
      );

      try {
        // 查询符合条件的知识点
        const entries = queryEntries(db, type, project, min_confidence, include_outdated);

        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: false,
                    message: "⚠️ 没有找到符合条件的知识点",
                    count: 0,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        log(`查询到 ${entries.length} 条知识点`);

        // 根据格式导出
        let content: string;
        if (format === "markdown") {
          content = exportToMarkdown(entries);
        } else {
          content = exportToJSON(entries);
        }

        // 如果指定了输出路径，写入文件
        if (output_path) {
          const fullPath = output_path.startsWith("~")
            ? join(homedir(), output_path.slice(1))
            : output_path;

          writeFileSync(fullPath, content, "utf-8");
          log(`已写入文件：${fullPath}`);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    message: `✅ 成功导出 ${entries.length} 条知识点到 ${fullPath}`,
                    count: entries.length,
                    file_path: fullPath,
                    format,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // 否则返回内容字符串
        log(`导出完成，返回内容字符串`);
        return {
          content: [
            {
              type: "text" as const,
              text: content,
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`导出失败：${errMsg}`);
        if (error instanceof Error && error.stack) {
          log(`堆栈：${error.stack}`);
        }

        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ 导出失败：${errMsg}`,
            },
          ],
        };
      }
    }
  );
}
