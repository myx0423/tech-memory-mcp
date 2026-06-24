import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { insertKnowledge, insertVector, searchVectorJS, updateKnowledge, incrementAccess } from "../db.js";
import { getSingleEmbedding } from "../embeddings.js";
import { ulid } from "ulidx";
import type { KnowledgeCategory, KnowledgeEntry } from "../types.js";

function log(msg: string) {
  process.stderr.write(`[tech_import] ${msg}\n`);
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

// 默认衰减率
function getDefaultDecayRate(category: KnowledgeCategory): number {
  const rates: Record<KnowledgeCategory, number> = {
    fact: 0.05,
    decision: 0.02,
    lesson: 0.01,
    preference: 0.03,
    pattern: 0.01,
  };
  return rates[category] ?? 0.02;
}

// 从 JSON 文件导入
async function importFromJSON(
  db: Database,
  filePath: string
): Promise<{ imported: number; skipped_duplicate: number; failed: number }> {
  const fullPath = filePath.startsWith("~")
    ? join(homedir(), filePath.slice(1))
    : filePath;

  const content = readFileSync(fullPath, "utf-8");
  const data = JSON.parse(content);

  if (!Array.isArray(data)) {
    throw new Error("JSON 文件必须包含一个数组");
  }

  let imported = 0;
  let skipped_duplicate = 0;
  let failed = 0;

  for (const item of data) {
    try {
      // 验证必要字段
      if (!item.content || !item.category) {
        log(`跳过无效条目：缺少 content 或 category`);
        failed++;
        continue;
      }

      // 计算嵌入向量
      const embedding = await getSingleEmbedding(item.content);

      // 语义去重
      const candidates = searchVectorJS(db, embedding, 5);
      const dedupThreshold = 0.85;

      let isDuplicate = false;
      for (const candidate of candidates) {
        if (candidate.similarity >= dedupThreshold) {
          // 重复，更新现有条目
          const updated = updateKnowledge(db, candidate.knowledge_id, {
            content: item.content,
            category: item.category,
            tags: item.tags || [],
            project: item.project,
            importance: item.importance ?? 0.5,
          });

          if (updated) {
            db.prepare("DELETE FROM knowledge_embeddings WHERE knowledge_id = ?").run(candidate.knowledge_id);
            insertVector(db, candidate.knowledge_id, embedding);
            incrementAccess(db, candidate.knowledge_id);
            skipped_duplicate++;
            isDuplicate = true;
            break;
          }
        }
      }

      if (!isDuplicate) {
        // 创建新条目
        const id = item.id || ulid();
        const category = item.category as KnowledgeCategory;

        insertKnowledge(db, {
          id,
          content: item.content,
          category,
          tags: item.tags || [],
          source_conversation: item.source_conversation,
          project: item.project,
          importance: item.importance ?? 0.5,
          confidence: item.confidence ?? 0.7,
          decay_rate: item.decay_rate ?? getDefaultDecayRate(category),
          expires_at: item.expires_at ?? null,
          impression_count: 0,
          adoption_count: 0,
          last_impression_at: null,
        });

        insertVector(db, id, embedding);
        imported++;
      }
    } catch (err) {
      log(`导入条目失败：${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  return { imported, skipped_duplicate, failed };
}

// 从 Markdown 文件导入
async function importFromMarkdown(
  db: Database,
  filePath: string,
  defaultType: KnowledgeCategory = "lesson"
): Promise<{ imported: number; skipped: number; parsed_items: any[] }> {
  const fullPath = filePath.startsWith("~")
    ? join(homedir(), filePath.slice(1))
    : filePath;

  const content = readFileSync(fullPath, "utf-8");
  const lines = content.split("\n");

  const items: Array<{
    title: string;
    content: string;
    type: KnowledgeCategory;
    tags: string[];
  }> = [];

  let currentItem: {
    title: string;
    contentLines: string[];
    type: KnowledgeCategory;
    tags: string[];
  } | null = null;

  // 解析 Markdown
  for (const line of lines) {
    // 检测二级标题（## ）
    if (line.startsWith("## ")) {
      // 保存上一个条目
      if (currentItem) {
        items.push({
          title: currentItem.title,
          content: currentItem.contentLines.join("\n").trim(),
          type: currentItem.type,
          tags: currentItem.tags,
        });
      }

      // 开始新条目
      currentItem = {
        title: line.slice(3).trim(),
        contentLines: [],
        type: defaultType,
        tags: [],
      };
    } else if (currentItem) {
      // 解析元数据行
      const typeMatch = line.match(/^type:\s*(.+)$/i);
      if (typeMatch) {
        const typeValue = typeMatch[1].trim().toLowerCase();
        if (["decision", "lesson", "preference", "fact", "pattern"].includes(typeValue)) {
          currentItem.type = typeValue as KnowledgeCategory;
        }
        continue;
      }

      const tagsMatch = line.match(/^tags:\s*(.+)$/i);
      if (tagsMatch) {
        const tagsValue = tagsMatch[1].trim();
        currentItem.tags = tagsValue.split(",").map((t) => t.trim()).filter((t) => t);
        continue;
      }

      // 跳过元数据行和分隔线
      if (line.startsWith("**") || line.startsWith("---") || line.trim() === "") {
        continue;
      }

      // 添加内容行
      currentItem.contentLines.push(line);
    }
  }

  // 保存最后一个条目
  if (currentItem) {
    items.push({
      title: currentItem.title,
      content: currentItem.contentLines.join("\n").trim(),
      type: currentItem.type,
      tags: currentItem.tags,
    });
  }

  let imported = 0;
  let skipped = 0;
  const parsed_items: any[] = [];

  // 存储解析出的条目
  for (const item of items) {
    try {
      if (!item.content || item.content.length < 10) {
        log(`跳过过短条目：${item.title}`);
        skipped++;
        continue;
      }

      // 计算嵌入向量
      const embedding = await getSingleEmbedding(item.content);

      // 语义去重
      const candidates = searchVectorJS(db, embedding, 5);
      const dedupThreshold = 0.85;

      let isDuplicate = false;
      for (const candidate of candidates) {
        if (candidate.similarity >= dedupThreshold) {
          log(`跳过重复条目：${item.title}`);
          skipped++;
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        const id = ulid();
        insertKnowledge(db, {
          id,
          content: item.content,
          category: item.type,
          tags: item.tags,
          importance: 0.5,
          confidence: 0.7,
          decay_rate: getDefaultDecayRate(item.type),
          expires_at: null,
          impression_count: 0,
          adoption_count: 0,
          last_impression_at: null,
        });

        insertVector(db, id, embedding);
        imported++;

        parsed_items.push({
          id,
          title: item.title,
          type: item.type,
          tags: item.tags,
        });
      }
    } catch (err) {
      log(`导入条目失败：${item.title} - ${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  return { imported, skipped, parsed_items };
}

// 从纯文本批量导入
async function importFromText(
  db: Database,
  text: string,
  project?: string
): Promise<{ imported: number; failed: number }> {
  // 简单分割：按段落分割
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length >= 20);

  let imported = 0;
  let failed = 0;

  for (const paragraph of paragraphs) {
    try {
      // 计算嵌入向量
      const embedding = await getSingleEmbedding(paragraph);

      // 语义去重
      const candidates = searchVectorJS(db, embedding, 5);
      const dedupThreshold = 0.85;

      let isDuplicate = false;
      for (const candidate of candidates) {
        if (candidate.similarity >= dedupThreshold) {
          log(`跳过重复段落`);
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        const id = ulid();
        insertKnowledge(db, {
          id,
          content: paragraph,
          category: "lesson", // 默认类型
          tags: [],
          project,
          importance: 0.5,
          confidence: 0.6, // 未经验证的文本，置信度较低
          decay_rate: getDefaultDecayRate("lesson"),
          expires_at: null,
          impression_count: 0,
          adoption_count: 0,
          last_impression_at: null,
        });

        insertVector(db, id, embedding);
        imported++;
      }
    } catch (err) {
      log(`导入段落失败：${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  return { imported, failed };
}

export function registerImportTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_import",
    {
      description:
        "从外部来源批量导入技术知识。支持三种导入方式：\n" +
        "1. 从 JSON 文件导入（tech_export 导出的格式）\n" +
        "2. 从 Markdown 文件导入（Obsidian/通用笔记格式）\n" +
        "3. 从纯文本批量导入（自动分割段落并存储）\n" +
        "所有导入都会自动进行语义去重，避免重复条目。",
      inputSchema: z
        .object({
          file_path: z
            .string()
            .optional()
            .describe("JSON 或 Markdown 文件路径（可选）。支持绝对路径或 ~ 开头的家目录路径"),
          text: z
            .string()
            .optional()
            .describe("纯文本内容（可选）。适合从聊天记录、文档直接导入"),
          default_type: z
            .enum(["decision", "lesson", "preference", "fact", "pattern"])
            .optional()
            .default("lesson")
            .describe("Markdown 导入时的默认知识类型，默认 lesson"),
          project: z
            .string()
            .optional()
            .describe("纯文本导入时指定的项目名（可选）"),
        })
        .strict()
        .refine((data) => data.file_path || data.text, {
          message: "必须提供 file_path 或 text 参数之一",
        }),
    },
    async (params) => {
      const { file_path, text, default_type = "lesson", project } = params;

      log(`开始导入：file_path=${file_path ?? "N/A"} text_length=${text?.length ?? 0}`);

      try {
        // 从 JSON 文件导入
        if (file_path && file_path.endsWith(".json")) {
          const result = await importFromJSON(db, file_path);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    message: `✅ 导入完成：新增 ${result.imported} 条，跳过重复 ${result.skipped_duplicate} 条，失败 ${result.failed} 条`,
                    ...result,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // 从 Markdown 文件导入
        if (file_path && (file_path.endsWith(".md") || file_path.endsWith(".markdown"))) {
          const result = await importFromMarkdown(db, file_path, default_type);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    message: `✅ 导入完成：新增 ${result.imported} 条，跳过 ${result.skipped} 条`,
                    imported: result.imported,
                    skipped: result.skipped,
                    parsed_items: result.parsed_items,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // 从纯文本导入
        if (text) {
          const result = await importFromText(db, text, project);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    message: `✅ 导入完成：新增 ${result.imported} 条，失败 ${result.failed} 条`,
                    ...result,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  message: "❌ 未提供有效的导入参数",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`导入失败：${errMsg}`);
        if (error instanceof Error && error.stack) {
          log(`堆栈：${error.stack}`);
        }

        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ 导入失败：${errMsg}`,
            },
          ],
        };
      }
    }
  );
}
