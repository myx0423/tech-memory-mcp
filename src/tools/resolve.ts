import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { getKnowledge, deleteKnowledge, updateKnowledge, createEdge } from "../db.js";
import { ulid } from "ulidx";

function log(msg: string) {
  process.stderr.write(`[tech_resolve] ${msg}\n`);
}

export function registerResolveTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_resolve",
    {
      description:
        "处理一对冲突的知识条目。支持四种操作：保留 A（删除 B）、保留 B（删除 A）、" +
        "保留两者（创建矛盾关系边）、合并（用新内容更新 A，删除 B）。",
      inputSchema: z
        .object({
          id_a: z
            .string()
            .min(1, "知识点 ID 不能为空")
            .describe("冲突对中的第一个知识点 ID"),
          id_b: z
            .string()
            .min(1, "知识点 ID 不能为空")
            .describe("冲突对中的第二个知识点 ID"),
          action: z
            .enum(["keep_a", "keep_b", "keep_both", "merge"])
            .describe(
              "处理操作：keep_a=保留 A 删除 B，keep_b=保留 B 删除 A，" +
              "keep_both=两者都保留并创建矛盾关系，merge=合并为一条（用 merge_content 更新 A，删除 B）"
            ),
          merge_content: z
            .string()
            .optional()
            .describe("合并后的内容（action=merge 时必填）"),
        })
        .strict(),
    },
    async (params) => {
      const { id_a, id_b, action, merge_content } = params;

      log(`处理冲突：id_a=${id_a} id_b=${id_b} action=${action}`);

      try {
        const entryA = getKnowledge(db, id_a);
        const entryB = getKnowledge(db, id_b);

        if (!entryA) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `❌ 知识点 ${id_a} 不存在`,
              },
            ],
          };
        }

        if (!entryB) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `❌ 知识点 ${id_b} 不存在`,
              },
            ],
          };
        }

        let resultMessage = "";
        let deletedId: string | null = null;
        let keptId: string | null = null;

        switch (action) {
          case "keep_a":
            // 保留 A，删除 B
            deleteKnowledge(db, id_b);
            deletedId = id_b;
            keptId = id_a;
            resultMessage = `✅ 已保留知识点 A（${id_a}），删除知识点 B（${id_b}）`;
            log(`保留 ${id_a}，删除 ${id_b}`);
            break;

          case "keep_b":
            // 保留 B，删除 A
            deleteKnowledge(db, id_a);
            deletedId = id_a;
            keptId = id_b;
            resultMessage = `✅ 已保留知识点 B（${id_b}），删除知识点 A（${id_a}）`;
            log(`保留 ${id_b}，删除 ${id_a}`);
            break;

          case "keep_both":
            // 两者都保留，创建矛盾关系
            createEdge(db, {
              id: ulid(),
              from_id: id_a,
              to_id: id_b,
              relationship: "contradicts",
            });
            keptId = `${id_a} 和 ${id_b}`;
            resultMessage = `✅ 已保留两个知识点，并创建矛盾关系（${id_a} → ${id_b}）`;
            log(`创建矛盾关系：${id_a} → ${id_b}`);
            break;

          case "merge":
            // 合并：用新内容更新 A，删除 B
            if (!merge_content) {
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: `❌ action=merge 时必须提供 merge_content`,
                  },
                ],
              };
            }

            // 更新 A 的内容，置信度取两者较高值
            const higherConfidence = Math.max(entryA.confidence, entryB.confidence);
            updateKnowledge(db, id_a, {
              content: merge_content,
              category: entryA.category,
              tags: [...new Set([...entryA.tags, ...entryB.tags])],
              source_conversation: entryA.source_conversation ?? entryB.source_conversation,
              project: entryA.project ?? entryB.project,
              importance: Math.max(entryA.importance, entryB.importance),
            });

            // 手动更新置信度
            db.prepare("UPDATE knowledge SET confidence = ? WHERE id = ?").run(higherConfidence, id_a);

            // 删除 B
            deleteKnowledge(db, id_b);
            deletedId = id_b;
            keptId = id_a;
            resultMessage = `✅ 已合并知识点：用新内容更新 A（${id_a}），删除 B（${id_b}）。合并后置信度：${higherConfidence.toFixed(2)}`;
            log(`合并：更新 ${id_a}，删除 ${id_b}，置信度=${higherConfidence}`);
            break;
        }

        const keptEntry = keptId && !keptId.includes("和") ? getKnowledge(db, keptId) : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  action,
                  kept_id: keptId,
                  deleted_id: deletedId,
                  kept_entry: keptEntry,
                  message: resultMessage,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`处理失败：${errMsg}`);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ 处理冲突失败：${errMsg}`,
            },
          ],
        };
      }
    }
  );
}
