import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import * as z from "zod";
import { getSingleEmbedding } from "../embeddings.js";
import {
  searchVectorJS,
  searchFTS,
  getKnowledge,
  incrementAccess,
} from "../db.js";
import type { SearchResult } from "../types.js";

// === Logging (stderr only — stdout is MCP JSON-RPC) ===
function log(msg: string) {
  process.stderr.write(`[tech_search] ${msg}\n`);
}

// === RRF constant ===
const RRF_K = 60;

// === Regex for detecting pure-English technical queries ===
// Matches strings composed of ASCII letters, digits, whitespace, and common
// technical symbols (hyphens, underscores, dots, hashes, plus signs, etc.)
const PURE_ENGLISH_RE = /^[a-zA-Z0-9\s\-_+#.(){}\[\],:;!?/\\@$%^&*=~`'"<>|]+$/;

export function registerSearchTool(server: McpServer, db: DatabaseSync) {
  server.registerTool(
    "tech_search",
    {
      description:
        "混合检索技术知识库：同时执行向量语义搜索和全文关键词搜索，通过倒数排名融合（RRF）合并排序。" +
        "支持按知识类型和项目过滤，返回最相关的技术知识和经验。",
      inputSchema: z
        .object({
          query: z
            .string()
            .min(1, "查询内容不能为空")
            .max(500, "查询内容不能超过 500 字符")
            .describe("搜索查询（中文或英文），支持自然语言和技术术语"),
          limit: z
            .number()
            .int("返回数必须为整数")
            .min(1, "至少返回 1 条结果")
            .max(50, "最多返回 50 条结果")
            .optional()
            .default(10)
            .describe("返回结果数量，默认 10 条，最多 50 条"),
          category: z
            .enum(["decision", "lesson", "preference", "fact", "pattern"])
            .optional()
            .describe(
              "按知识类型过滤：decision=技术决策、lesson=经验教训、" +
                "preference=个人偏好、fact=技术事实、pattern=通用模式。" +
                "不指定则返回所有类型"
            ),
          project: z
            .string()
            .optional()
            .describe("按来源项目过滤，仅返回指定项目的知识。不指定则返回所有项目的知识"),
          hybrid_alpha: z
            .number()
            .min(0, "权重不能小于 0")
            .max(1, "权重不能大于 1")
            .optional()
            .default(0.7)
            .describe(
              "向量搜索权重 0-1，默认 0.7。0=纯全文关键词搜索，" +
                "1=纯向量语义搜索。中文语义查询建议 0.6-0.8"
            ),
        })
        .strict(),
    },
    async (params) => {
      const { query, limit, category, project, hybrid_alpha } = params;

      // Adjust alpha for pure-English technical queries — English terms are
      // better served by FTS, so we cap the vector weight at 0.5.
      let alpha = hybrid_alpha;
      const isPureEnglish = PURE_ENGLISH_RE.test(query.trim());
      if (isPureEnglish && hybrid_alpha > 0.5) {
        alpha = 0.5;
        log(
          `检测到纯英文技术查询，将向量权重从 ${hybrid_alpha} 调整为 ${alpha}（更侧重全文搜索）`
        );
      }

      log(
        `开始搜索：query="${query}" limit=${limit} alpha=${alpha} ` +
          `category=${category ?? "全部"} project=${project ?? "全部"}`
      );

      try {
        // Step 1: Compute query embedding
        log("正在计算查询向量嵌入...");
        const embedding = await getSingleEmbedding(query);
        log(`嵌入计算完成，维度=${embedding.length}`);

        // Step 2: Run vector and FTS searches IN PARALLEL
        // Fetch limit*2 candidates from each to provide enough material for RRF
        const fetchLimit = limit * 2;
        log(`并行执行向量搜索和全文搜索（各取 ${fetchLimit} 条候选）...`);

        const [vecHits, ftsHits] = await Promise.all([
          searchVectorJS(db, embedding, fetchLimit),
          searchFTS(db, query, fetchLimit),
        ]);

        log(
          `向量搜索返回 ${vecHits.length} 条，全文搜索返回 ${ftsHits.length} 条`
        );

        // Handle edge case: both searches return nothing
        if (vecHits.length === 0 && ftsHits.length === 0) {
          log("两个搜索通道均无结果");
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    results: [] as SearchResult[],
                    query,
                    total_found: 0,
                    message:
                      `🔍 未找到与「${query}」相关的知识。\n\n` +
                      `建议尝试以下方式扩大搜索范围：\n` +
                      `1. 使用更简短或更宽泛的关键词\n` +
                      `2. 尝试用中文关键词搜索（当前为纯英文查询）\n` +
                      `3. 移除分类或项目过滤条件\n` +
                      `4. 改用同义词或相关术语重新搜索`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Step 3: Map FTS rowids to knowledge IDs
        // FTS returns {rowid, rank} — we need to resolve rowid → id for RRF merge
        const ftsRowidToId = new Map<number, string>();

        if (ftsHits.length > 0) {
          const placeholders = ftsHits
            .map(() => "?")
            .join(", ");
          const rowids = ftsHits.map((h) => h.rowid);
          const rows = db
            .prepare(
              `SELECT rowid, id FROM knowledge WHERE rowid IN (${placeholders})`
            )
            .all(...rowids) as { rowid: number; id: string }[];

          for (const row of rows) {
            ftsRowidToId.set(row.rowid, row.id);
          }
          log(
            `FTS rowid→id 映射完成：${rows.length}/${ftsHits.length} 条有效`
          );
        }

        // Step 4: Reciprocal Rank Fusion (RRF) merge
        // score(doc) = sum over each ranked list of: weight / (k + rank_position)
        // where rank_position is 1-based
        const fusedScores = new Map<string, number>();
        const vecRanks = new Map<string, number>(); // knowledge_id → 0-based index
        const ftsRanks = new Map<string, number>(); // knowledge_id → 0-based index

        // Vector contributions
        for (let i = 0; i < vecHits.length; i++) {
          const hit = vecHits[i];
          const id = hit.knowledge_id;
          const rrfScore = alpha / (RRF_K + i + 1);
          fusedScores.set(id, (fusedScores.get(id) ?? 0) + rrfScore);
          vecRanks.set(id, i);
        }

        // FTS contributions
        for (let i = 0; i < ftsHits.length; i++) {
          const hit = ftsHits[i];
          const id = ftsRowidToId.get(hit.rowid);
          if (!id) {
            // FTS index may reference a row deleted after the search
            continue;
          }
          const rrfScore = (1 - alpha) / (RRF_K + i + 1);
          fusedScores.set(id, (fusedScores.get(id) ?? 0) + rrfScore);
          ftsRanks.set(id, i);
        }

        log(`RRF 融合完成，共 ${fusedScores.size} 个不重复候选项`);

        // Step 5: Sort by fused score descending, apply limit
        const sortedIds = [...fusedScores.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit);

        log(`RRF 排序后取前 ${sortedIds.length} 条`);

        // Step 6: Fetch full KnowledgeEntry objects and apply filters
        const results: SearchResult[] = [];
        for (const [id, score] of sortedIds) {
          const entry = getKnowledge(db, id);
          if (!entry) {
            // Entry may have been deleted between search and retrieval
            log(`跳过已删除条目：${id}`);
            continue;
          }

          // Apply category filter (post-RRF)
          if (category !== undefined && entry.category !== category) {
            continue;
          }

          // Apply project filter (post-RRF)
          if (project !== undefined && entry.project !== project) {
            continue;
          }

          const vectorRank = vecRanks.has(id)
            ? vecRanks.get(id)! + 1 // Convert to 1-based rank
            : undefined;
          const ftsRank = ftsRanks.has(id)
            ? ftsRanks.get(id)! + 1 // Convert to 1-based rank
            : undefined;

          results.push({
            entry,
            score: Math.round(score * 1_000_000) / 1_000_000, // Round to 6 decimal places
            vector_rank: vectorRank,
            fts_rank: ftsRank,
          });
        }

        // Step 7: Increment access counts for returned entries
        for (const result of results) {
          incrementAccess(db, result.entry.id);
        }

        // Step 8: Handle empty results after filtering
        if (results.length === 0) {
          const filterDesc: string[] = [];
          if (category) filterDesc.push(`类型=${category}`);
          if (project) filterDesc.push(`项目=${project}`);

          log(
            `过滤后无结果（${filterDesc.join("，")}），原始候选=${sortedIds.length} 条`
          );

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    results: [] as SearchResult[],
                    query,
                    total_found: 0,
                    message:
                      `🔍 为「${query}」找到 ${sortedIds.length} 条语义相关结果，` +
                      `但在当前过滤条件（${filterDesc.join("、") || "无"}）下无匹配。\n\n` +
                      `建议：\n` +
                      `1. 移除过滤条件后重新搜索\n` +
                      `2. 尝试更宽泛的关键词`,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Build summary message
        const categoryCounts: Record<string, number> = {};
        for (const r of results) {
          categoryCounts[r.entry.category] =
            (categoryCounts[r.entry.category] ?? 0) + 1;
        }
        const catSummary = Object.entries(categoryCounts)
          .map(([k, v]) => `${k}:${v}`)
          .join("，");

        const topEntry = results[0].entry;
        log(
          `搜索完成：返回 ${results.length} 条（${catSummary}），最佳匹配="${topEntry.content.slice(0, 50)}..."`
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  results,
                  query,
                  total_found: results.length,
                  alpha_used: alpha,
                  message:
                    `🔍 搜索「${query}」找到 ${results.length} 条相关知识（${catSummary}）。\n\n` +
                    `**最佳匹配**（RRF 融合分数 ${results[0].score.toFixed(6)}）：\n` +
                    `- 类别：${topEntry.category}\n` +
                    `- 内容：${topEntry.content}\n` +
                    `- 标签：${topEntry.tags.length > 0 ? topEntry.tags.join("、") : "无"}\n` +
                    `- 项目：${topEntry.project ?? "未指定"}` +
                    (results[0].vector_rank
                      ? `\n- 向量排名：#${results[0].vector_rank}`
                      : "") +
                    (results[0].fts_rank
                      ? `\n- 全文排名：#${results[0].fts_rank}`
                      : ""),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`搜索失败：${errMsg}`);
        if (error instanceof Error && error.stack) {
          log(`堆栈：${error.stack}`);
        }
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `❌ 搜索失败：${errMsg}\n\n` +
                `请检查：\n` +
                `1. 嵌入模型服务是否正常运行\n` +
                `2. FTS5 全文索引是否已正确构建\n` +
                `3. 数据库连接是否正常`,
            },
          ],
        };
      }
    }
  );
}
