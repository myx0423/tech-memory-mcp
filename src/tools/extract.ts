import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Read extraction prompt at module load time
const __dirname = dirname(fileURLToPath(import.meta.url));
const extractionPrompt = readFileSync(
  join(__dirname, "..", "prompts", "extraction.zh.md"),
  "utf-8"
);

// === 提取条目 Zod Schema（带中文 describe） ===

const extractedItemSchema = z.object({
  content: z
    .string()
    .describe("知识要点内容，中文为主，简洁清晰。一句话说清是什么、为什么重要。"),
  category: z
    .enum(["decision", "lesson", "preference", "fact", "pattern"])
    .describe(
      "知识分类: decision=技术决策(为什么选A不选B), lesson=经验教训(踩过的坑), preference=个人偏好(用户习惯/工作流), fact=技术事实(配置参数/版本兼容性), pattern=通用模式(可复用的架构/方案)"
    ),
  tags: z
    .array(z.string())
    .describe("标签列表，便于检索。使用小写英文或中文，如 ['react', '性能优化', 'ssr']"),
  project: z
    .string()
    .optional()
    .describe("来源项目名称，如 'my-blog'、'tech-memory-mcp'。若无法确定可省略。"),
  importance: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("重要程度: 0.0=可忽略, 0.3=低, 0.5=一般, 0.7=高, 1.0=至关重要。默认 0.5。"),
});

const extractionArraySchema = z
  .array(extractedItemSchema)
  .describe("从对话中提取的技术知识条目数组");

// === 将 Zod Schema 转为 JSON Schema 供 LLM 使用 ===

function buildJsonSchema(): object {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "array",
    description:
      "从对话中提取的技术知识条目数组。每条知识应独立、有用、可复用。",
    items: {
      type: "object",
      required: ["content", "category", "tags"],
      properties: {
        content: {
          type: "string",
          description:
            "知识要点内容，中文为主，简洁清晰。一句话说清是什么、为什么重要。",
        },
        category: {
          type: "string",
          enum: ["decision", "lesson", "preference", "fact", "pattern"],
          description:
            "知识分类: decision=技术决策(为什么选A不选B), lesson=经验教训(踩过的坑), preference=个人偏好(用户习惯/工作流), fact=技术事实(配置参数/版本兼容性), pattern=通用模式(可复用的架构/方案)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "标签列表，便于检索。使用小写英文或中文，如 ['react', '性能优化', 'ssr']",
        },
        project: {
          type: "string",
          description:
            "来源项目名称，如 'my-blog'、'tech-memory-mcp'。若无法确定可省略。",
        },
        importance: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.5,
          description:
            "重要程度: 0.0=可忽略, 0.3=低, 0.5=一般, 0.7=高, 1.0=至关重要。默认 0.5。",
        },
      },
      additionalProperties: false,
    },
  };
}

// === 注册工具 ===

export function registerExtractTemplateTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_extract_template",
    {
      description:
        "返回知识提取的提示词和 JSON Schema，供 LLM 从对话中提取结构化技术知识。调用后 LLM 可根据返回的模板从对话历史中识别并提取 decision/lesson/preference/fact/pattern 五类知识。",
      inputSchema: z
        .object({
          format: z
            .enum(["full", "prompt_only", "schema_only"])
            .optional()
            .default("full")
            .describe(
              "返回格式: full=完整模板(提示词+JSON Schema+使用说明), prompt_only=仅提示词, schema_only=仅 JSON Schema"
            ),
        })
        .strict(),
    },
    async ({ format }) => {
      const jsonSchema = buildJsonSchema();
      const instructions =
        "请根据以上提示词和 JSON Schema，从对话中提取有价值的技术知识。" +
        "每条知识至少包含 content（内容）、category（分类）和 tags（标签），" +
        "可选 project（来源项目）和 importance（重要程度 0-1，默认 0.5）。" +
        "提取时注意：只提取有长期复用价值的知识，忽略临时性、事务性的信息。";

      process.stderr.write(
        `[tech-memory] tech_extract_template requested (format=${format})\n`
      );

      switch (format) {
        case "prompt_only":
          return {
            content: [{ type: "text", text: extractionPrompt }],
          };
        case "schema_only":
          return {
            content: [
              { type: "text", text: JSON.stringify(jsonSchema, null, 2) },
            ],
          };
        case "full":
        default:
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    prompt: extractionPrompt,
                    json_schema: jsonSchema,
                    instructions,
                  },
                  null,
                  2
                ),
              },
            ],
          };
      }
    }
  );
}
