import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import * as z from "zod";
import { getSingleEmbedding } from "../embeddings.js";
import {
  insertKnowledge,
  insertVector,
  searchVectorJS,
  getKnowledge,
  updateKnowledge,
  incrementAccess,
} from "../db.js";
import { ulid } from "ulidx";

// === Logging (stderr only — stdout is MCP JSON-RPC) ===
function log(msg: string) {
  process.stderr.write(`[tech_store] ${msg}\n`);
}

export function registerStoreTool(server: McpServer, db: DatabaseSync) {
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
      } = params;

      log(
        `开始存储：类别=${category} 内容长度=${content.length} 去重阈值=${dedup_threshold} 重要性=${importance}`
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
