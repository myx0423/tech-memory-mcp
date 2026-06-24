#!/usr/bin/env node
import { initDatabase } from "./db.js";
import { writeFileSync, readFileSync, copyFileSync, statSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import { ulid } from "ulidx";
import type { KnowledgeEntry, KnowledgeCategory } from "./types.js";

function log(msg: string) {
  process.stderr.write(`[tech-memory-cli] ${msg}\n`);
}

// 行数据转换为 KnowledgeEntry
function rowToEntry(row: any): KnowledgeEntry {
  return {
    id: row.id,
    content: row.content,
    category: row.category as KnowledgeCategory,
    tags: JSON.parse(row.tags || "[]"),
    source_conversation: row.source_conversation ?? undefined,
    project: row.project ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    access_count: row.access_count ?? 0,
    importance: row.importance ?? 0.5,
    confidence: row.confidence ?? 0.7,
    confirmed_count: row.confirmed_count ?? 0,
    decay_rate: row.decay_rate ?? 0.02,
    last_confirmed_at: row.last_confirmed_at ?? null,
    expires_at: row.expires_at ?? null,
    is_outdated: row.is_outdated ?? 0,
    impression_count: row.impression_count ?? 0,
    adoption_count: row.adoption_count ?? 0,
    last_impression_at: row.last_impression_at ?? null,
  };
}

// 导出为 Markdown
function exportToMarkdown(entries: KnowledgeEntry[]): string {
  const now = new Date().toISOString();
  const lines: string[] = [];

  lines.push(`# 技术知识导出`);
  lines.push(``);
  lines.push(`**导出时间**: ${now}`);
  lines.push(`**总条目数**: ${entries.length}`);
  lines.push(``);

  const grouped = new Map<string, KnowledgeEntry[]>();
  for (const entry of entries) {
    const category = entry.category;
    if (!grouped.has(category)) {
      grouped.set(category, []);
    }
    grouped.get(category)!.push(entry);
  }

  const categoryLabels: Record<string, string> = {
    decision: "技术决策",
    lesson: "经验教训",
    preference: "个人偏好",
    fact: "技术事实",
    pattern: "通用模式",
  };

  for (const [category, categoryEntries] of grouped) {
    const label = categoryLabels[category] || category;
    lines.push(`## ${category} (${label})`);
    lines.push(``);

    for (const entry of categoryEntries) {
      lines.push(`### ${entry.id}`);
      lines.push(``);

      if (entry.project) {
        lines.push(`**项目**: ${entry.project}`);
        lines.push(``);
      }

      lines.push(`**置信度**: ${entry.confidence.toFixed(2)}`);
      lines.push(``);

      if (entry.tags.length > 0) {
        lines.push(`**标签**: ${entry.tags.join(", ")}`);
        lines.push(``);
      }

      lines.push(`**创建时间**: ${entry.created_at}`);
      lines.push(``);

      lines.push(entry.content);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }
  }

  return lines.join("\n");
}

// 导出为 JSON
function exportToJSON(entries: KnowledgeEntry[]): string {
  const exportData = entries.map((entry) => ({
    id: entry.id,
    content: entry.content,
    category: entry.category,
    tags: entry.tags,
    source_conversation: entry.source_conversation,
    project: entry.project,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    access_count: entry.access_count,
    importance: entry.importance,
    confidence: entry.confidence,
    confirmed_count: entry.confirmed_count,
    decay_rate: entry.decay_rate,
    last_confirmed_at: entry.last_confirmed_at,
    expires_at: entry.expires_at,
    is_outdated: entry.is_outdated,
  }));

  return JSON.stringify(exportData, null, 2);
}

// 导出命令
function exportCommand(args: string[]) {
  const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : "markdown";
  const output = args.includes("--output") ? args[args.indexOf("--output") + 1] : null;

  log(`执行导出：format=${format} output=${output ?? "stdout"}`);

  const db = initDatabase();
  const rows = db.prepare("SELECT * FROM knowledge ORDER BY category, created_at DESC").all() as any[];
  const entries = rows.map(rowToEntry);

  let content: string;
  if (format === "json") {
    content = exportToJSON(entries);
  } else {
    content = exportToMarkdown(entries);
  }

  if (output) {
    writeFileSync(output, content, "utf-8");
    console.log(`✅ 已导出 ${entries.length} 条知识到 ${output}`);
  } else {
    console.log(content);
  }
}

// 导入命令
function importCommand(args: string[]) {
  const file = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;

  if (!file) {
    console.error("❌ 错误：必须指定 --file 参数");
    process.exit(1);
  }

  log(`执行导入：file=${file}`);

  const db = initDatabase();
  const content = readFileSync(file, "utf-8");
  const data = JSON.parse(content);

  if (!Array.isArray(data)) {
    console.error("❌ 错误：JSON 文件必须包含数组");
    process.exit(1);
  }

  let imported = 0;
  let skipped = 0;

  for (const item of data) {
    try {
      if (!item.content || !item.category) {
        skipped++;
        continue;
      }

      const id = item.id || ulid();
      const category = item.category as KnowledgeCategory;

      db.prepare(`
        INSERT INTO knowledge (id, content, content_fts, category, tags, source_conversation, project, created_at, updated_at, importance, confidence, decay_rate, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        item.content,
        item.content,
        category,
        JSON.stringify(item.tags || []),
        item.source_conversation ?? null,
        item.project ?? null,
        item.created_at || new Date().toISOString(),
        item.updated_at || new Date().toISOString(),
        item.importance ?? 0.5,
        item.confidence ?? 0.7,
        item.decay_rate ?? 0.02,
        item.expires_at ?? null
      );

      imported++;
    } catch (err) {
      log(`导入失败：${err instanceof Error ? err.message : String(err)}`);
      skipped++;
    }
  }

  console.log(`✅ 导入完成：新增 ${imported} 条，跳过 ${skipped} 条`);
}

// 备份命令
function backupCommand(args: string[]) {
  const backupPath = args.includes("--path") ? args[args.indexOf("--path") + 1] : null;

  log(`执行备份：path=${backupPath ?? "默认"}`);

  const sourcePath = join(homedir(), ".tech-memory", "memory.db");

  let targetPath: string;
  if (backupPath) {
    targetPath = backupPath;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    targetPath = join(homedir(), ".tech-memory", `backup-${timestamp}.db`);
  }

  const targetDir = dirname(targetPath);
  mkdirSync(targetDir, { recursive: true });

  copyFileSync(sourcePath, targetPath);

  const stats = statSync(targetPath);
  const db = initDatabase();
  const countRow = db.prepare("SELECT COUNT(*) as count FROM knowledge").get() as any;
  const knowledgeCount = countRow?.count ?? 0;

  console.log(`✅ 备份完成`);
  console.log(`   路径: ${targetPath}`);
  console.log(`   大小: ${(stats.size / 1024).toFixed(1)} KB`);
  console.log(`   知识: ${knowledgeCount} 条`);
}

// 主函数
function main() {
  const command = process.argv[2];

  if (!command) {
    console.log(`
用法:
  tech-memory-cli export [--format markdown|json] [--output <file>]
  tech-memory-cli import --file <file>
  tech-memory-cli backup [--path <file>]

示例:
  tech-memory-cli export --format json --output knowledge.json
  tech-memory-cli import --file knowledge.json
  tech-memory-cli backup --path ~/backup.db
`);
    process.exit(0);
  }

  const args = process.argv.slice(3);

  switch (command) {
    case "export":
      exportCommand(args);
      break;
    case "import":
      importCommand(args);
      break;
    case "backup":
      backupCommand(args);
      break;
    default:
      console.error(`❌ 未知命令: ${command}`);
      process.exit(1);
  }
}

main();
