import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { insertKnowledge, insertVector, searchVectorJS, updateKnowledge, incrementAccess } from "../db.js";
import { getSingleEmbedding } from "../embeddings.js";
import { ulid } from "ulidx";
import type { KnowledgeCategory } from "../types.js";

// Read extraction prompt at module load time
const __dirname = dirname(fileURLToPath(import.meta.url));
const extractionPrompt = readFileSync(
  join(__dirname, "..", "prompts", "extraction.zh.md"),
  "utf-8"
);

// === Logging ===
function log(msg: string) {
  process.stderr.write(`[tech_auto_extract] ${msg}\n`);
}

// === Keywords that indicate valuable knowledge ===
const VALUABLE_KEYWORDS = [
  "错误", "报错", "失败", "解决", "fix", "error",
  "选择", "决定", "发现", "原来",
  "bug", "问题", "原因", "方案", "优化", "性能",
  "踩坑", "经验", "教训", "注意", "必须",
];

// === Default decay rate by category ===
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

// === Check if conversation is worth extracting ===
function shouldExtract(conversation: string, minLength: number): { worth: boolean; reason: string } {
  // Check length
  if (conversation.length >= minLength) {
    return { worth: true, reason: `对话长度 ${conversation.length} >= ${minLength}` };
  }

  // Check keywords
  const lowerConv = conversation.toLowerCase();
  for (const keyword of VALUABLE_KEYWORDS) {
    if (lowerConv.includes(keyword.toLowerCase())) {
      return { worth: true, reason: `包含关键词: ${keyword}` };
    }
  }

  return {
    worth: false,
    reason: `对话长度 ${conversation.length} < ${minLength} 且未包含有价值关键词`,
  };
}

// === Filter low quality items ===
function filterItems(items: ExtractedItem[]): {
  passed: ExtractedItem[];
  skippedLowConfidence: number;
  skippedShort: number;
} {
  const passed: ExtractedItem[] = [];
  let skippedLowConfidence = 0;
  let skippedShort = 0;

  for (const item of items) {
    // Check confidence
    if (item.confidence < 0.6) {
      skippedLowConfidence++;
      continue;
    }

    // Check length
    if (item.title.length < 10 || item.content.length < 10) {
      skippedShort++;
      continue;
    }

    passed.push(item);
  }

  return { passed, skippedLowConfidence, skippedShort };
}

// === Store a single item ===
async function storeItem(
  db: Database,
  item: ExtractedItem,
  project?: string
): Promise<{ id: string; action: "created" | "updated" }> {
  // Compute embedding
  const embedding = await getSingleEmbedding(item.content);

  // Semantic dedup
  const candidates = searchVectorJS(db, embedding, 5);
  const dedupThreshold = 0.85;

  for (const candidate of candidates) {
    if (candidate.similarity >= dedupThreshold) {
      // Duplicate - update existing
      const updated = updateKnowledge(db, candidate.knowledge_id, {
        content: item.content,
        category: item.type,
        tags: item.tags,
        project: project,
        importance: item.confidence,
      });

      if (updated) {
        // Update vector
        db.prepare("DELETE FROM knowledge_embeddings WHERE knowledge_id = ?").run(candidate.knowledge_id);
        insertVector(db, candidate.knowledge_id, embedding);
        incrementAccess(db, candidate.knowledge_id);
        return { id: candidate.knowledge_id, action: "updated" };
      }
      break;
    }
  }

  // Create new
  const id = ulid();
  insertKnowledge(db, {
    id,
    content: item.content,
    category: item.type,
    tags: item.tags,
    project: project,
    importance: item.confidence,
    confidence: item.confidence,
    decay_rate: getDefaultDecayRate(item.type),
    expires_at: null,
    impression_count: 0,
    adoption_count: 0,
    last_impression_at: null,
  });
  insertVector(db, id, embedding);

  return { id, action: "created" };
}

// === Extracted item schema ===
interface ExtractedItem {
  type: KnowledgeCategory;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
}

// === Build extraction prompt for LLM ===
function buildExtractionPrompt(conversation: string, project?: string): string {
  let prompt = extractionPrompt + "\n\n";
  prompt += "## 待提取的对话内容\n\n";
  prompt += "```\n" + conversation + "\n```\n\n";

  if (project) {
    prompt += `## 项目信息\n\n项目名称: ${project}\n\n`;
  }

  prompt += "## 输出要求\n\n";
  prompt += "请以 JSON 数组格式输出提取的知识条目，每个条目包含以下字段：\n";
  prompt += "- `type`: 知识类型 (decision | lesson | preference | fact | pattern)\n";
  prompt += "- `title`: 简短标题（10-30字）\n";
  prompt += "- `content`: 详细内容（50-500字）\n";
  prompt += "- `tags`: 标签数组（3-8个）\n";
  prompt += "- `confidence`: 置信度 0-1（根据知识价值和确定性评估）\n\n";
  prompt += "只输出 JSON，不要其他内容。如果没有值得提取的知识，输出空数组 []。\n";

  return prompt;
}

// === Register tool ===
export function registerAutoExtractTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_auto_extract",
    {
      description:
        "自动从对话中提取并存储技术知识。工具会判断对话是否值得提取（长度>=阈值或包含关键词），" +
        "如果值得提取则返回提取提示词，LLM 执行提取后再次调用此工具传入 extracted_items 完成存储。" +
        "支持 dry_run 模式预览提取结果。",
      inputSchema: z
        .object({
          conversation: z
            .string()
            .optional()
            .describe("本次对话的完整文本（user/assistant 交替）。首次调用时提供。"),
          project: z
            .string()
            .optional()
            .describe("当前项目名，用于知识分类和过滤"),
          min_length: z
            .number()
            .optional()
            .default(500)
            .describe("对话字符数阈值，低于此值且不含关键词则跳过提取"),
          dry_run: z
            .boolean()
            .optional()
            .default(false)
            .describe("预览模式：只返回提取提示词，不实际存储"),
          extracted_items: z
            .array(
              z.object({
                type: z.enum(["decision", "lesson", "preference", "fact", "pattern"]),
                title: z.string(),
                content: z.string(),
                tags: z.array(z.string()),
                confidence: z.number().min(0).max(1),
              })
            )
            .optional()
            .describe("LLM 提取的知识条目数组。第二次调用时提供。"),
        })
        .strict(),
    },
    async (params) => {
      const { conversation, project, min_length = 500, dry_run = false, extracted_items } = params;

      // === Phase 2: Store extracted items ===
      if (extracted_items !== undefined) {
        log(`收到 ${extracted_items.length} 条提取结果，开始存储...`);

        // Filter low quality items
        const { passed, skippedLowConfidence, skippedShort } = filterItems(extracted_items);
        log(`过滤结果: ${passed.length} 条通过, ${skippedLowConfidence} 条置信度过低, ${skippedShort} 条内容过短`);

        if (dry_run) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    extracted: extracted_items.length,
                    passed_filter: passed.length,
                    skipped_low_confidence: skippedLowConfidence,
                    skipped_short: skippedShort,
                    items: passed,
                    message: `预览模式：${passed.length} 条知识将通过过滤，未实际存储。`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Store items
        const results: Array<{ id: string; action: string; title: string }> = [];
        for (const item of passed) {
          try {
            const result = await storeItem(db, item, project);
            results.push({
              id: result.id,
              action: result.action,
              title: item.title,
            });
            log(`已存储: ${item.title} (${result.action})`);
          } catch (err) {
            log(`存储失败: ${item.title} - ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  extracted: extracted_items.length,
                  stored: results.length,
                  skipped_low_confidence: skippedLowConfidence,
                  skipped_short: skippedShort,
                  items: results,
                  message: `✅ 成功存储 ${results.length} 条知识。`,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // === Phase 1: Check if worth extracting ===
      if (!conversation) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "缺少 conversation 参数",
                message: "首次调用需要提供 conversation 参数",
              }),
            },
          ],
          isError: true,
        };
      }

      const { worth, reason } = shouldExtract(conversation, min_length);

      if (!worth) {
        log(`跳过提取: ${reason}`);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                skipped: true,
                reason,
                message: `⏭️ 跳过提取: ${reason}`,
              }),
            },
          ],
        };
      }

      log(`触发提取: ${reason}`);

      // Build extraction prompt for LLM
      const prompt = buildExtractionPrompt(conversation, project);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                skipped: false,
                reason,
                extraction_prompt: prompt,
                instructions:
                  "请根据上述提示词从对话中提取知识条目，然后再次调用 tech_auto_extract 工具，" +
                  "传入 extracted_items 参数（JSON 数组格式）完成存储。" +
                  "每个条目需包含: type, title, content, tags, confidence。",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
