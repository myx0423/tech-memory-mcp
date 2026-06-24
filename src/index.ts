#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDatabase, getStats } from "./db.js";
import { registerSearchTool } from "./tools/search.js";
import { registerStoreTool } from "./tools/store.js";
import { registerExtractTemplateTool } from "./tools/extract.js";
import { registerLinkTool } from "./tools/link.js";
import { registerGetTool } from "./tools/get.js";
import { registerStatsTool } from "./tools/stats.js";
import { registerAutoExtractTool } from "./tools/auto_extract.js";
import { registerConfirmTool } from "./tools/confirm.js";
import { registerDecayTool } from "./tools/decay.js";
import { registerOutdatedTool } from "./tools/outdated.js";
import { registerUsageStatsTool } from "./tools/usage_stats.js";
import { registerConflictScanTool } from "./tools/conflict_scan.js";
import { registerResolveTool } from "./tools/resolve.js";
import { registerExportTool } from "./tools/export.js";
import { registerImportTool } from "./tools/import.js";
import { registerBackupTool } from "./tools/backup.js";
import { warmupEmbeddings } from "./embeddings.js";

function log(msg: string) {
  process.stderr.write(`[tech-memory] ${msg}\n`);
}

async function main() {
  log("tech-memory-mcp v0.1.0 启动中...");

  // 初始化数据库（自动创建 ~/.tech-memory/memory.db）
  const db = initDatabase();

  // 预热嵌入模型（后台下载，不阻塞服务启动）
  warmupEmbeddings().then(
    () => log("嵌入模型就绪"),
    (err) => log(`嵌入模型预热失败（首次搜索时会重试）: ${err.message}`)
  );

  // 创建 MCP Server
  const server = new McpServer({
    name: "tech-memory-mcp",
    version: "0.1.0",
  });

  // 注册工具
  registerSearchTool(server, db);
  registerStoreTool(server, db);
  registerExtractTemplateTool(server, db);
  registerLinkTool(server, db);
  registerGetTool(server, db);
  registerStatsTool(server, db);
  registerAutoExtractTool(server, db);
  registerConfirmTool(server, db);
  registerDecayTool(server, db);
  registerOutdatedTool(server, db);
  registerUsageStatsTool(server, db);
  registerConflictScanTool(server, db);
  registerResolveTool(server, db);
  registerExportTool(server, db);
  registerImportTool(server, db);
  registerBackupTool(server, db);

  // 通过 stdio 连接
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const stats = getStats(db);
  log(
    `就绪。已存储 ${stats.total_entries} 条知识，` +
    `${stats.total_edges} 条关联。` +
    `数据库: ${stats.db_size_bytes > 0 ? (stats.db_size_bytes / 1024).toFixed(0) + " KB" : "内存"}`
  );
}

main().catch((err) => {
  process.stderr.write(`[tech-memory] 致命错误: ${err.message}\n`);
  if (err.stack) {
    process.stderr.write(`[tech-memory] ${err.stack}\n`);
  }
  process.exit(1);
});
