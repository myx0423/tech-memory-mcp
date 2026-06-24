import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "better-sqlite3";
import * as z from "zod";
import { copyFileSync, statSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

function log(msg: string) {
  process.stderr.write(`[tech_backup] ${msg}\n`);
}

export function registerBackupTool(server: McpServer, db: Database) {
  server.registerTool(
    "tech_backup",
    {
      description:
        "创建完整的 SQLite 数据库备份。默认备份到 ~/.tech-memory/backup-{timestamp}.db，" +
        "也可指定自定义路径。备份使用文件复制方式保证一致性。",
      inputSchema: z
        .object({
          backup_path: z
            .string()
            .optional()
            .describe("备份文件路径（可选）。默认 ~/.tech-memory/backup-{timestamp}.db"),
        })
        .strict(),
    },
    async (params) => {
      const { backup_path } = params;

      log("开始数据库备份...");

      try {
        // 确定源数据库路径
        const sourcePath = join(homedir(), ".tech-memory", "memory.db");

        // 确定目标路径
        let targetPath: string;
        if (backup_path) {
          targetPath = backup_path.startsWith("~")
            ? join(homedir(), backup_path.slice(1))
            : backup_path;
        } else {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          targetPath = join(homedir(), ".tech-memory", `backup-${timestamp}.db`);
        }

        // 确保目标目录存在
        const targetDir = dirname(targetPath);
        mkdirSync(targetDir, { recursive: true });

        // 复制数据库文件
        log(`复制 ${sourcePath} -> ${targetPath}`);
        copyFileSync(sourcePath, targetPath);

        // 获取备份文件大小
        const stats = statSync(targetPath);
        const sizeBytes = stats.size;

        // 获取知识点数量
        const countRow = db.prepare("SELECT COUNT(*) as count FROM knowledge").get() as any;
        const knowledgeCount = countRow?.count ?? 0;

        log(`备份完成：${targetPath} (${sizeBytes} bytes, ${knowledgeCount} 条知识)`);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  backup_path: targetPath,
                  size_bytes: sizeBytes,
                  knowledge_count: knowledgeCount,
                  message: `✅ 数据库备份完成\n\n` +
                    `**备份路径**: ${targetPath}\n` +
                    `**文件大小**: ${(sizeBytes / 1024).toFixed(1)} KB\n` +
                    `**知识条目**: ${knowledgeCount} 条`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log(`备份失败：${errMsg}`);
        if (error instanceof Error && error.stack) {
          log(`堆栈：${error.stack}`);
        }

        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `❌ 数据库备份失败：${errMsg}`,
            },
          ],
        };
      }
    }
  );
}
