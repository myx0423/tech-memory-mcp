import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { getAllEmbeddings, getKnowledge, cosineSimilarity } from "../db.js";
import type { KnowledgeEntry } from "../types.js";

function log(msg: string) {
  process.stderr.write(`[tech_conflict_scan] ${msg}\n`);
}

interface ConflictPair {
  item_a: KnowledgeEntry;
  item_b: KnowledgeEntry;
  similarity: number;
  conflict_type: string;
  suggestion: string;
}

function checkConflictPair(
  contentA: string,
  contentB: string,
  categoryA: string,
  categoryB: string,
  projectA: string | undefined,
  projectB: string | undefined,
  similarity: number
): string | null {
  // Rule 1: Same project + same category + similarity > 0.85 → duplicate
  if (projectA && projectB && projectA === projectB &&
      categoryA === categoryB && similarity > 0.85) {
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

  const aLower = contentA.toLowerCase();
  const bLower = contentB.toLowerCase();

  for (const [a, b] of contradictionPairs) {
    const hasAInA = aLower.includes(a.toLowerCase());
    const hasBInB = bLower.includes(b.toLowerCase());
    const hasBInA = aLower.includes(b.toLowerCase());
    const hasAInB = bLower.includes(a.toLowerCase());

    if ((hasAInA && hasBInB) || (hasBInA && hasAInB)) {
      if (similarity > 0.75) {
        return "contradiction";
      }
    }
  }

  // Rule 3: Same project, both decisions, similarity > 0.7
  if (projectA && projectB && projectA === projectB &&
      categoryA === "decision" && categoryB === "decision" && similarity > 0.7) {
    return "contradiction";
  }

  return null;
}

export function registerConflictScanTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_conflict_scan",
    {
      description:
        "扫描整个知识库，找出所有潜在的冲突条目。通过计算条目间的语义相似度，" +
        "检测重复、矛盾或过时的知识。支持按类型、项目过滤，可设置相似度阈值。" +
        "默认 dry_run=true 只返回结果不修改数据。",
      inputSchema: z
        .object({
          category: z
            .enum(["decision", "lesson", "preference", "fact", "pattern"])
            .optional()
            .describe("只扫描指定类型的知识"),
          project: z
            .string()
            .optional()
            .describe("只扫描指定项目的知识"),
          similarity_threshold: z
            .number()
            .min(0, "阈值不能小于 0")
            .max(1, "阈值不能大于 1")
            .optional()
            .default(0.75)
            .describe("相似度阈值，默认 0.75。只有相似度超过此值的条目对才会被检查"),
          dry_run: z
            .boolean()
            .optional()
            .default(true)
            .describe("预览模式，默认 true。只返回冲突列表，不自动处理"),
        })
        .strict(),
    },
    async (params) => {
      const { category, project, similarity_threshold, dry_run } = params;

      log(`开始扫描冲突：category=${category ?? "全部"} project=${project ?? "全部"} threshold=${similarity_threshold} dry_run=${dry_run}`);

      try {
        // Get all embeddings
        const allEmbeddings = getAllEmbeddings(db);
        log(`获取到 ${allEmbeddings.length} 个向量`);

        // Filter by category and project
        const filteredIds = new Set<string>();
        for (const { knowledge_id } of allEmbeddings) {
          const entry = getKnowledge(db, knowledge_id);
          if (!entry) continue;
          
          if (category && entry.category !== category) continue;
          if (project && entry.project !== project) continue;
          
          filteredIds.add(knowledge_id);
        }

        const filteredEmbeddings = allEmbeddings.filter(({ knowledge_id }) => filteredIds.has(knowledge_id));
        log(`过滤后剩余 ${filteredEmbeddings.length} 个条目`);

        if (filteredEmbeddings.length < 2) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  total_scanned: filteredEmbeddings.length,
                  conflict_pairs: [],
                  message: "条目数量不足，无法进行冲突扫描",
                }),
              },
            ],
          };
        }

        // Compare all pairs
        const conflictPairs: ConflictPair[] = [];
        const processedPairs = new Set<string>();

        for (let i = 0; i < filteredEmbeddings.length; i++) {
          for (let j = i + 1; j < filteredEmbeddings.length; j++) {
            const embA = filteredEmbeddings[i];
            const embB = filteredEmbeddings[j];

            // Create unique pair key
            const pairKey = [embA.knowledge_id, embB.knowledge_id].sort().join("-");
            if (processedPairs.has(pairKey)) continue;
            processedPairs.add(pairKey);

            const similarity = cosineSimilarity(embA.embedding, embB.embedding);
            
            if (similarity < similarity_threshold) continue;

            const entryA = getKnowledge(db, embA.knowledge_id);
            const entryB = getKnowledge(db, embB.knowledge_id);
            
            if (!entryA || !entryB) continue;

            const conflictType = checkConflictPair(
              entryA.content,
              entryB.content,
              entryA.category,
              entryB.category,
              entryA.project,
              entryB.project,
              similarity
            );

            if (conflictType) {
              conflictPairs.push({
                item_a: entryA,
                item_b: entryB,
                similarity,
                conflict_type: conflictType,
                suggestion: conflictType === "duplicate" ? "overwrite" : conflictType === "contradiction" ? "link" : "keep_both",
              });
            }
          }
        }

        log(`扫描完成：发现 ${conflictPairs.length} 对冲突`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  total_scanned: filteredEmbeddings.length,
                  conflict_pairs: conflictPairs,
                  message: `🔍 扫描完成：共检查 ${filteredEmbeddings.length} 个条目，发现 ${conflictPairs.length} 对冲突。\n\n` +
                    (conflictPairs.length > 0
                      ? "使用 tech_resolve 工具处理冲突：\n" +
                        conflictPairs.map((p, i) => 
                          `${i + 1}. ${p.conflict_type}: "${p.item_a.content.slice(0, 30)}..." vs "${p.item_b.content.slice(0, 30)}..." (相似度 ${(p.similarity * 100).toFixed(1)}%)`
                        ).join("\n")
                      : "未发现冲突，知识库状态良好！"),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`扫描失败：${errMsg}`);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ 冲突扫描失败：${errMsg}`,
            },
          ],
        };
      }
    }
  );
}
