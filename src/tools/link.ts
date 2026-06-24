import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import * as z from "zod";
import { getKnowledge, createEdge } from "../db.js";
import { ulid } from "ulidx";

function log(msg: string) {
  process.stderr.write(`[tech_link] ${msg}\n`);
}

export function registerLinkTool(server: McpServer, db: DatabaseSync) {
  server.registerTool(
    "tech_link",
    {
      description:
        "创建知识点之间的有向关系边。支持四种关系类型：" +
        "related（双向相关，两个知识点互相参考）、" +
        "depends_on（源依赖目标，目标知识点是源的前置条件）、" +
        "supersedes（源替代目标，目标知识点已过时，系统会自动将目标的重要性降为 0.2 作为过期信号）、" +
        "contradicts（源与目标矛盾，需要人工审查解决冲突）。" +
        "每个 (from_id, to_id, relationship) 三元组全局唯一，重复创建会返回友好提示。",
      inputSchema: z
        .object({
          from_id: z
            .string()
            .describe("源知识点 ULID，关系的出发点。该知识点必须已存在于知识库中。"),
          to_id: z
            .string()
            .describe("目标知识点 ULID，关系的指向点。该知识点必须已存在于知识库中。"),
          relationship: z
            .enum(["related", "depends_on", "supersedes", "contradicts"])
            .describe(
              "关系类型，决定边的语义方向。" +
                "related: 双向相关，两个知识点在内容上互有关联；" +
                "depends_on: 源依赖于目标，即目标知识点是源的前置条件或基础；" +
                "supersedes: 源替代目标，目标知识点被视为已过时，系统会自动将其重要性降为 0.2；" +
                "contradicts: 源与目标存在矛盾，标记为待人工审查的冲突。"
            ),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    async (params) => {
      const { from_id, to_id, relationship } = params;

      // 1. 验证源知识点是否存在
      const fromEntry = getKnowledge(db, from_id);
      if (!fromEntry) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `❌ 错误：源知识点 ${from_id} 不存在。` +
                `请先使用 tech_save 创建该知识点，或使用 tech_search 搜索确认 ULID 是否正确。`,
            },
          ],
          isError: true,
        };
      }

      // 2. 验证目标知识点是否存在
      const toEntry = getKnowledge(db, to_id);
      if (!toEntry) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `❌ 错误：目标知识点 ${to_id} 不存在。` +
                `请先使用 tech_save 创建该知识点，或使用 tech_search 搜索确认 ULID 是否正确。`,
            },
          ],
          isError: true,
        };
      }

      // 3. 检查关系是否已存在（UNIQUE 约束预检）
      const existingEdge = db
        .prepare(
          "SELECT id, created_at FROM knowledge_edges WHERE from_id = ? AND to_id = ? AND relationship = ?"
        )
        .get(from_id, to_id, relationship) as { id: string; created_at: string } | undefined;

      if (existingEdge) {
        const fromPreview = fromEntry.content.slice(0, 50);
        const toPreview = toEntry.content.slice(0, 50);
        log(
          `Duplicate edge prevented: ${from_id} --[${relationship}]--> ${to_id}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⚠️ 关系已存在，无需重复创建。\n\n` +
                `已有边 ID: ${existingEdge.id}\n` +
                `创建时间: ${existingEdge.created_at}\n` +
                `源知识点: 「${fromPreview}${fromEntry.content.length > 50 ? "..." : ""}」(${from_id})\n` +
                `目标知识点: 「${toPreview}${toEntry.content.length > 50 ? "..." : ""}」(${to_id})\n` +
                `关系类型: ${relationship}`,
            },
          ],
        };
      }

      // 4. 创建边
      const edge = createEdge(db, { id: ulid(), from_id, to_id, relationship });

      // 5. supersedes 关系：自动降低被替代条目的重要性
      let supersedeInfo = "";
      if (relationship === "supersedes") {
        const now = new Date().toISOString();
        db.prepare(
          "UPDATE knowledge SET importance = 0.2, updated_at = ? WHERE id = ?"
        ).run(now, to_id);
        supersedeInfo =
          `\n📌 副作用：已将旧知识「${toEntry.content.slice(0, 50)}${toEntry.content.length > 50 ? "..." : ""}」` +
          `的重要性从 ${toEntry.importance} 降至 0.2，标记为已被替代的过期条目。`;
        log(
          `Superseded entry ${to_id}: importance ${toEntry.importance} → 0.2`
        );
      }

      log(
        `Edge created: ${from_id} --[${relationship}]--> ${to_id} (edge: ${edge.id})`
      );

      // 6. 返回结果
      const fromPreview = fromEntry.content.slice(0, 80);
      const toPreview = toEntry.content.slice(0, 80);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `✅ 关系创建成功！\n\n` +
              `边 ID: ${edge.id}\n` +
              `源知识点: [${fromPreview}${fromEntry.content.length > 80 ? "..." : ""}] (${from_id})\n` +
              `目标知识点: [${toPreview}${toEntry.content.length > 80 ? "..." : ""}] (${to_id})\n` +
              `关系类型: ${relationship}\n` +
              `创建时间: ${edge.created_at}` +
              supersedeInfo,
          },
        ],
      };
    }
  );
}
