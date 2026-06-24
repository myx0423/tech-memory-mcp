import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { getSingleEmbedding } from "../embeddings.js";
import {
  insertKnowledge,
  insertVector,
  searchVectorJS,
  getKnowledge,
  updateKnowledge,
  incrementAccess,
  getEmbedding,
  cosineSimilarity,
} from "../db.js";
import { ulid } from "ulidx";
import type { KnowledgeCategory } from "../types.js";

// === Logging (stderr only — stdout is MCP JSON-RPC) ===
function log(msg: string) {
  process.stderr.write(`[tech_store] ${msg}\n`);
}

// === Default decay rate by category ===
function getDefaultDecayRate(category: string): number {
  const rates: Record<string, number> = {
    fact: 0.05,
    decision: 0.02,
    lesson: 0.01,
    preference: 0.03,
    pattern: 0.01,
  };
  return rates[category] ?? 0.02;
}

export function registerStoreTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_store",
    {
      description:
        "存储技术知识条目。自动生成 768 维向量嵌入，通过余弦相似度进行语义去重——" +
        "检测到高度相似内容时更新已有条目而非创建重复项，保持知识库精炼。",
      inputSchema: z
        .object({
          content: z
            .string()
            .min(1, "知识内容不能为空")
            .max(4000, "知识内容不能超过 4000 字符")
            .describe("技术知识要点（中文）"),
          category: z
            .enum(["decision", "lesson", "preference", "fact", "pattern"])
            .describe(
              "知识类型：decision=技术决策（为什么选A不选B）、lesson=经验教训（踩过的坑）、" +
                "preference=个人偏好（工作流倾向）、fact=技术事实（配置参数/版本兼容）、" +
                "pattern=通用模式（可复用架构/解决方案）"
            ),
          tags: z
            .array(z.string())
            .max(10, "标签最多 10 个")
            .optional()
            .describe("标签列表，最多 10 个，用于分类检索"),
          source_conversation: z
            .string()
            .optional()
            .describe("来源对话引用，便于追溯知识产生的上下文"),
          project: z
            .string()
            .optional()
            .describe("来源项目名，用于按项目过滤和统计"),
          importance: z
            .number()
            .min(0, "重要性不能小于 0")
            .max(1, "重要性不能大于 1")
            .optional()
            .default(0.5)
            .describe("重要性评分 0-1，0=琐碎信息 1=核心知识，默认 0.5"),
          dedup_threshold: z
            .number()
            .min(0, "阈值不能小于 0")
            .max(1, "阈值不能大于 1")
            .optional()
            .default(0.85)
            .describe(
              "语义去重相似度阈值 0-1，默认 0.85。两条知识的余弦相似度达到此值即视为重复，" +
                "将更新已有条目而非创建新条目。设为 1.0 可完全禁用来重"
            ),
          confidence: z
            .number()
            .min(0, "置信度不能小于 0")
            .max(1, "置信度不能大于 1")
            .optional()
            .default(0.7)
            .describe("初始置信度 0-1，默认 0.7。表示对这条知识的信任程度"),
          expires_at: z
            .string()
            .optional()
            .describe("过期时间（ISO 8601 格式，如 '2027-01-01'）。不传则永不过期"),
          decay_rate: z
            .number()
            .min(0, "衰减速率不能小于 0")
            .max(1, "衰减速率不能大于 1")
            .optional()
            .describe("衰减速率 0-1，不传则按类型取默认值（fact=0.05, decision=0.02, lesson=0.01, preference=0.03, pattern=0.01）"),
          force: z
            .boolean()
            .optional()
            .default(false)
            .describe("强制存储：忽略冲突检测直接存储，默认 false"),
        })
        .strict(),
    },
    async (params) => {
      const {
        content,
        category,
        tags,
        source_conversation,
        project,
        importance,
        dedup_threshold,
        confidence,
        expires_at,
        decay_rate,
        force,
      } = params;

      log(
        `开始存储：类别=${category} 内容长度=${content.length} 去重阈值=${dedup_threshold} 重要性=${importance} 强制=${force}`
      );

      try {
        // Step 1: Compute embedding for the incoming content
        log("正在计算向量嵌入...");
        const embedding = await getSingleEmbedding(content);
        log(`嵌入计算完成，维度=${embedding.length}`);

        // Step 2: Semantic dedup — query top-5 nearest neighbors
        log(`正在检索语义近邻进行去重检查（top-5）...`);
        const candidates = searchVectorJS(db, embedding, 5);
        log(`找到 ${candidates.length} 个候选近邻`);

        // Step 2.5: Conflict detection (before dedup)
        if (!force) {
          log("执行冲突检测...");
          const conflicts = detectConflicts(db, content, category, project, candidates, embedding);
          
          if (conflicts.length > 0) {
            log(`检测到 ${conflicts.length} 个冲突`);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      stored: false,
                      conflicts,
                      message: `⚠️ 检测到 ${conflicts.length} 个潜在冲突。使用 force=true 强制存储，或使用 tech_resolve 处理冲突。\n\n` +
                        conflicts.map(c => `• ${c.conflict_type}: ${c.title} (相似度 ${(c.similarity * 100).toFixed(1)}%)`).join("\n"),
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        for (const candidate of candidates) {
          const similarity = candidate.similarity;
          log(
            `候选 ${candidate.knowledge_id}：余弦相似度=${similarity.toFixed(4)}`
          );

          if (similarity >= dedup_threshold) {
            // Duplicate detected — update the existing entry
            log(
              `检测到重复知识！相似度 ${(similarity * 100).toFixed(1)}% >= 阈值 ${(dedup_threshold * 100).toFixed(0)}%，更新条目 ${candidate.knowledge_id}`
            );

            const updated = updateKnowledge(db, candidate.knowledge_id, {
              content,
              category,
              tags: tags ?? [],
              source_conversation: source_conversation ?? undefined,
              project: project ?? undefined,
              importance,
            });

            if (!updated) {
              // Race condition: entry was deleted between search and update.
              // Fall through to create a new entry instead.
              log(
                "警告：要更新的条目已被并发删除，改为创建新条目"
              );
              break;
            }

            // Update the vector embedding since content changed
            db.prepare(
              "DELETE FROM knowledge_embeddings WHERE knowledge_id = ?"
            ).run(candidate.knowledge_id);
            insertVector(db, candidate.knowledge_id, embedding);

            // Record this access
            incrementAccess(db, candidate.knowledge_id);

            log(`知识已更新：${updated.id}（原访问次数=${updated.access_count}）`);

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      action: "updated",
                      entry: updated,
                      similarity,
                      message: `✅ 检测到重复知识（语义相似度 ${(similarity * 100).toFixed(1)}%），已更新已有条目。\n\n` +
                        `**条目 ID**：\`${updated.id}\`\n` +
                        `**类别**：${updated.category}\n` +
                        `**内容**：${updated.content}\n` +
                        `**标签**：${updated.tags.length > 0 ? updated.tags.join("、") : "无"}\n` +
                        `**更新时间**：${updated.updated_at}`,
                    },
                    null,
                    2
                  ),
                },
              ],
            };
          }
        }

        // Step 3: No duplicate found — create a brand new entry
        log("未检测到重复，创建新知识条目...");
        const id = ulid();
        const entry = insertKnowledge(db, {
          id,
          content,
          category,
          tags: tags ?? [],
          source_conversation,
          project,
          importance,
          confidence,
          expires_at: expires_at ?? null,
          decay_rate: decay_rate ?? getDefaultDecayRate(category),
          impression_count: 0,
          adoption_count: 0,
          last_impression_at: null,
        });

        // Store vector embedding
        insertVector(db, id, embedding);

        log(`新知识已创建：${id}（类别=${entry.category} 标签数=${entry.tags.length}）`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action: "created",
                  entry,
                  message: `✅ 新知识已成功存储。\n\n` +
                    `**条目 ID**：\`${entry.id}\`\n` +
                    `**类别**：${entry.category}\n` +
                    `**内容**：${entry.content}\n` +
                    `**标签**：${entry.tags.length > 0 ? entry.tags.join("、") : "无"}\n` +
                    `**项目**：${entry.project ?? "未指定"}\n` +
                    `**重要性**：${entry.importance}\n` +
                    `**创建时间**：${entry.created_at}`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`存储失败：${errMsg}`);
        if (error instanceof Error && error.stack) {
          log(`堆栈：${error.stack}`);
        }
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ 存储知识失败：${errMsg}\n\n` +
                `请检查：\n` +
                `1. 内容是否超过 4000 字符限制\n` +
                `2. 嵌入模型服务是否正常运行\n` +
                `3. 数据库是否已正确初始化`,
            },
          ],
        };
      }
    }
  );
}

// === Conflict detection helpers ===

function checkConflict(
  newContent: string,
  existingContent: string,
  newCategory: string,
  existingCategory: string,
  newProject: string | undefined,
  existingProject: string | undefined,
  similarity: number
): "duplicate" | "contradiction" | "outdated" | null {
  // Rule 1: Same project + same category + title similarity > 0.85 → duplicate
  if (newProject && existingProject && newProject === existingProject &&
      newCategory === existingCategory && similarity > 0.85) {
    return "duplicate";
  }

  // Rule 2: Contradictory keywords
  const contradictionPairs = [
    ["选择A", "选择B"],
    ["不推荐", "推荐"],
    ["失败", "成功"],
    ["避免", "使用"],
    ["不要", "应该"],
    ["错误", "正确"],
  ];

  const newLower = newContent.toLowerCase();
  const existingLower = existingContent.toLowerCase();

  for (const [a, b] of contradictionPairs) {
    const hasAInNew = newLower.includes(a.toLowerCase());
    const hasBInExisting = existingLower.includes(b.toLowerCase());
    const hasBInNew = newLower.includes(b.toLowerCase());
    const hasAInExisting = existingLower.includes(a.toLowerCase());

    if ((hasAInNew && hasBInExisting) || (hasBInNew && hasAInExisting)) {
      if (similarity > 0.75) {
        return "contradiction";
      }
    }
  }

  // Rule 3: Same project, both decisions, same tech selection but opposite conclusions
  if (newProject && existingProject && newProject === existingProject &&
      newCategory === "decision" && existingCategory === "decision" && similarity > 0.7) {
    return "contradiction";
  }

  return null;
}

function detectConflicts(
  db: Database,
  newContent: string,
  newCategory: string,
  newProject: string | undefined,
  candidates: Array<{ knowledge_id: string; similarity: number }>,
  newEmbedding: Float32Array
): Array<{
  id: string;
  title: string;
  similarity: number;
  conflict_type: "duplicate" | "contradiction" | "outdated";
  suggestion: "overwrite" | "link" | "keep_both";
}> {
  const conflicts: Array<{
    id: string;
    title: string;
    similarity: number;
    conflict_type: "duplicate" | "contradiction" | "outdated";
    suggestion: "overwrite" | "link" | "keep_both";
  }> = [];

  for (const candidate of candidates) {
    if (candidate.similarity < 0.75) continue;

    const existing = getKnowledge(db, candidate.knowledge_id);
    if (!existing) continue;

    const conflictType = checkConflict(
      newContent,
      existing.content,
      newCategory,
      existing.category,
      newProject,
      existing.project,
      candidate.similarity
    );

    if (conflictType) {
      conflicts.push({
        id: existing.id,
        title: existing.content.slice(0, 50),
        similarity: candidate.similarity,
        conflict_type: conflictType,
        suggestion: conflictType === "duplicate" ? "overwrite" : conflictType === "contradiction" ? "link" : "keep_both",
      });
    }
  }

  return conflicts;
}
