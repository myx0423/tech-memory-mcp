import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import * as z from "zod";
import { getKnowledge, getRelatedKnowledge, incrementAccess } from "../db.js";

function log(msg: string) {
  process.stderr.write(`[tech_get] ${msg}\n`);
}

/** 关系类型的中文描述映射 */
const RELATIONSHIP_LABELS: Record<string, string> = {
  related: "相关",
  depends_on: "前置依赖",
  supersedes: "替代旧知识",
  contradicts: "相互矛盾",
};

/** 方向的中文描述映射 */
const DIRECTION_LABELS: Record<string, string> = {
  outgoing: "出边（当前知识点指向关联知识点）",
  incoming: "入边（关联知识点指向当前知识点）",
};

export function registerGetTool(server: McpServer, db: DatabaseSync) {
  server.registerTool(
    "tech_get",
    {
      description:
        "根据 ULID 检索单个知识点的完整信息，并可选择返回其一跳图邻居。" +
        "检索时自动增加该知识点的访问计数（access_count），用于追踪知识点的引用频率。" +
        "当 include_related 为 true 时，会遍历知识图谱中与该知识点直接相连的所有边，" +
        "返回的关联条目按关系类型（related / depends_on / supersedes / contradicts）分组，" +
        "每组内区分出边（outgoing）和入边（incoming），便于理解该知识点在知识网络中的位置和上下文依赖。",
      inputSchema: z
        .object({
          id: z.string().describe("要检索的知识点 ULID（Universally Unique Lexicographically Sortable Identifier）"),
          include_related: z
            .boolean()
            .optional()
            .default(true)
            .describe("是否包含关联知识点（图一跳邻居），默认 true。设为 false 可仅获取单条知识点，跳过图遍历。"),
          max_related: z
            .number()
            .int()
            .min(0)
            .max(20)
            .optional()
            .default(5)
            .describe("最大关联条目返回数，有效范围 0-20，默认 5。关联条目按边创建时间排序，超出限制的条目会被截断。"),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async (params) => {
      const { id, include_related, max_related } = params;

      // 1. 获取知识点
      const entry = getKnowledge(db, id);
      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `❌ 错误：知识点 ${id} 不存在。` +
                `请检查 ULID 是否正确，或使用 tech_search 按关键词搜索已有知识点。` +
                `如需创建新知识点，请使用 tech_save。`,
            },
          ],
          isError: true,
        };
      }

      // 2. 增加访问计数（追踪引用频率）
      incrementAccess(db, id);

      // 3. 构建主条目输出（access_count +1 反映本次访问）
      const entryOutput: Record<string, unknown> = {
        id: entry.id,
        content: entry.content,
        category: entry.category,
        tags: entry.tags,
        project: entry.project ?? null,
        importance: entry.importance,
        access_count: entry.access_count + 1,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      };
      // 仅当存在时才输出 source_conversation
      if (entry.source_conversation) {
        entryOutput.source_conversation = entry.source_conversation;
      }

      const result: Record<string, unknown> = {
        entry: entryOutput,
      };

      // 4. 获取关联知识点（图一跳遍历）
      if (include_related) {
        const related = getRelatedKnowledge(db, id, max_related);

        // 按关系类型分组
        const groups: Record<string, Array<Record<string, unknown>>> = {
          related: [],
          depends_on: [],
          supersedes: [],
          contradicts: [],
        };

        for (const rel of related) {
          const relEntry: Record<string, unknown> = {
            id: rel.entry.id,
            content: rel.entry.content,
            category: rel.entry.category,
            tags: rel.entry.tags,
            importance: rel.entry.importance,
            project: rel.entry.project ?? null,
            direction: rel.direction,
            direction_label: DIRECTION_LABELS[rel.direction] || rel.direction,
          };
          groups[rel.relationship].push(relEntry);
        }

        // 组装结构化关联结果
        const relatedGroups: Record<string, Record<string, unknown>> = {};
        for (const [relType, items] of Object.entries(groups)) {
          if (items.length > 0) {
            relatedGroups[relType] = {
              label: RELATIONSHIP_LABELS[relType] || relType,
              count: items.length,
              items,
            };
          }
        }

        result.related = {
          total: related.length,
          max_related_requested: max_related,
          groups: relatedGroups,
        };

        log(`Related entries for ${id}: ${related.length} found (max: ${max_related})`);
      }

      log(`Knowledge entry retrieved: ${id}`);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
