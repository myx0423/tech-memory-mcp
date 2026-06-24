import DatabaseConstructor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { ulid } from "ulidx";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, statSync } from "fs";
import type {
  KnowledgeEntry,
  KnowledgeEdge,
  KnowledgeCategory,
  RelationshipType,
  DatabaseStats,
  UsageEvent,
  UsageEventType,
  UsageStats,
} from "./types.js";

// === Logging (stderr only — stdout is MCP JSON-RPC) ===
function log(msg: string) {
  process.stderr.write(`[tech-memory] ${msg}\n`);
}

// === Database path ===
function defaultDbPath(): string {
  const dir = join(homedir(), ".tech-memory");
  mkdirSync(dir, { recursive: true });
  return join(dir, "memory.db");
}

// === Vector serialization ===
export function serializeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function deserializeVector(buf: Buffer): Float32Array {
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

// === Database initialization ===
let _db: Database | null = null;

export function initDatabase(dbPath?: string): Database {
  if (_db) return _db;

  const path = dbPath ?? defaultDbPath();
  log(`打开数据库: ${path}`);

  const db = new DatabaseConstructor(path);

  // Enable WAL mode and foreign keys
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Run migrations
  const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const currentVersion = versionRow?.user_version ?? 0;
  log(`DB schema version: ${currentVersion}`);

  if (currentVersion < 1) {
    migrate_v1(db);
  }
  if (currentVersion < 2) {
    migrate_v2(db);
  }
  if (currentVersion < 3) {
    migrate_v3(db);
  }
  if (currentVersion < 4) {
    migrate_v4(db);
  }

  _db = db;
  return db;
}

export function getDatabase(): Database {
  if (!_db) throw new Error("数据库未初始化，请先调用 initDatabase()");
  return _db;
}

// === Migration: v1 (initial schema) ===
function migrate_v1(db: Database): void {
  log("执行迁移 v1: 初始 schema");

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      content_fts TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('decision','lesson','preference','fact','pattern')),
      tags TEXT DEFAULT '[]',
      source_conversation TEXT,
      project TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      access_count INTEGER DEFAULT 0,
      importance REAL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1)
    );

    CREATE TABLE IF NOT EXISTS knowledge_edges (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
      relationship TEXT NOT NULL CHECK(relationship IN ('related','depends_on','supersedes','contradicts')),
      created_at TEXT NOT NULL,
      UNIQUE(from_id, to_id, relationship)
    );

    -- Embedding storage (BLOB, 768-dim Float32)
    CREATE TABLE IF NOT EXISTS knowledge_embeddings (
      knowledge_id TEXT PRIMARY KEY REFERENCES knowledge(id) ON DELETE CASCADE,
      embedding BLOB NOT NULL
    );

    -- Full-text search (FTS5 with content sync)
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      content_fts,
      tags,
      content=knowledge,
      content_rowid=rowid
    );

    -- FTS5 sync triggers
    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, content_fts, tags) VALUES (new.rowid, new.content_fts, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content_fts, tags) VALUES('delete', old.rowid, old.content_fts, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content_fts, tags) VALUES('delete', old.rowid, old.content_fts, old.tags);
      INSERT INTO knowledge_fts(rowid, content_fts, tags) VALUES (new.rowid, new.content_fts, new.tags);
    END;

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge(category);
    CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project);
    CREATE INDEX IF NOT EXISTS idx_knowledge_created ON knowledge(created_at);
    CREATE INDEX IF NOT EXISTS idx_edges_from ON knowledge_edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON knowledge_edges(to_id);
  `);

  db.exec("PRAGMA user_version = 1");
  log("迁移 v1 完成");
}

// === Migration: v2 (add content_fts column for Chinese preprocessing) ===
function migrate_v2(db: Database): void {
  log("执行迁移 v2: 添加 content_fts 列");

  // 1. Add content_fts column if not already present (v1 may already include it)
  const columns = db.prepare("PRAGMA table_info('knowledge')").all() as any[];
  const hasContentFts = columns.some((c: any) => c.name === "content_fts");
  if (!hasContentFts) {
    db.exec("ALTER TABLE knowledge ADD COLUMN content_fts TEXT NOT NULL DEFAULT ''");
  } else {
    log("content_fts 列已存在，跳过 ALTER TABLE");
  }

  // 2. Backfill existing data (ensure non-empty content_fts)
  const rows = db.prepare("SELECT rowid, content FROM knowledge").all() as any[];
  for (const row of rows) {
    const contentFts = preprocessChineseForFTS(row.content);
    db.prepare("UPDATE knowledge SET content_fts = ? WHERE rowid = ?").run(contentFts, row.rowid);
  }

  // 3. Drop and recreate FTS virtual table
  db.exec("DROP TABLE IF EXISTS knowledge_fts");
  db.exec(`
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(
      content_fts,
      tags,
      content=knowledge,
      content_rowid=rowid
    )
  `);

  // 4. Recreate triggers
  db.exec(`
    DROP TRIGGER IF EXISTS knowledge_ai;
    DROP TRIGGER IF EXISTS knowledge_ad;
    DROP TRIGGER IF EXISTS knowledge_au;
  `);

  db.exec(`
    CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, content_fts, tags) VALUES (new.rowid, new.content_fts, new.tags);
    END;

    CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content_fts, tags) VALUES('delete', old.rowid, old.content_fts, old.tags);
    END;

    CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content_fts, tags) VALUES('delete', old.rowid, old.content_fts, old.tags);
      INSERT INTO knowledge_fts(rowid, content_fts, tags) VALUES (new.rowid, new.content_fts, new.tags);
    END;
  `);

  db.exec("PRAGMA user_version = 2");
  log(`迁移 v2 完成，已回填 ${rows.length} 条记录`);
}

// === Migration: v3 (add confidence and aging fields) ===
function migrate_v3(db: Database): void {
  log("执行迁移 v3: 添加置信度和老化字段");

  // 添加新字段
  db.exec(`
    ALTER TABLE knowledge ADD COLUMN confidence REAL DEFAULT 0.7 CHECK(confidence >= 0 AND confidence <= 1);
    ALTER TABLE knowledge ADD COLUMN confirmed_count INTEGER DEFAULT 0;
    ALTER TABLE knowledge ADD COLUMN decay_rate REAL DEFAULT 0.02;
    ALTER TABLE knowledge ADD COLUMN last_confirmed_at TEXT;
    ALTER TABLE knowledge ADD COLUMN expires_at TEXT;
    ALTER TABLE knowledge ADD COLUMN is_outdated INTEGER DEFAULT 0 CHECK(is_outdated IN (0, 1));
  `);

  // 根据 category 设置默认 decay_rate
  db.exec(`
    UPDATE knowledge SET decay_rate = 0.05 WHERE category = 'fact';
    UPDATE knowledge SET decay_rate = 0.02 WHERE category = 'decision';
    UPDATE knowledge SET decay_rate = 0.01 WHERE category = 'lesson';
    UPDATE knowledge SET decay_rate = 0.03 WHERE category = 'preference';
    UPDATE knowledge SET decay_rate = 0.01 WHERE category = 'pattern';
  `);

  db.exec("PRAGMA user_version = 3");
  log("迁移 v3 完成");
}

// === Migration: v4 (add usage tracking fields and usage_events table) ===
function migrate_v4(db: Database): void {
  log("执行迁移 v4: 添加使用反馈闭环字段和 usage_events 表");

  // 添加 knowledge 表新字段
  db.exec(`
    ALTER TABLE knowledge ADD COLUMN impression_count INTEGER DEFAULT 0;
    ALTER TABLE knowledge ADD COLUMN adoption_count INTEGER DEFAULT 0;
    ALTER TABLE knowledge ADD COLUMN last_impression_at INTEGER DEFAULT NULL;
  `);

  // 创建 usage_events 表
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('impression', 'adoption', 'rejection')),
      query TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (knowledge_id) REFERENCES knowledge(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_usage_events_knowledge_id ON usage_events(knowledge_id);
    CREATE INDEX IF NOT EXISTS idx_usage_events_event_type ON usage_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events(created_at);
  `);

  db.exec("PRAGMA user_version = 4");
  log("迁移 v4 完成");
}

// === Knowledge CRUD ===

export function insertKnowledge(
  db: Database,
  entry: Omit<KnowledgeEntry, "created_at" | "updated_at" | "access_count" | "confirmed_count" | "last_confirmed_at" | "is_outdated">
): KnowledgeEntry {
  const now = new Date().toISOString();
  const id = entry.id || ulid();
  const tags = JSON.stringify(entry.tags ?? []);
  const contentFts = preprocessChineseForFTS(entry.content);

  // 根据 category 设置默认 decay_rate
  const defaultDecayRates: Record<string, number> = {
    fact: 0.05,
    decision: 0.02,
    lesson: 0.01,
    preference: 0.03,
    pattern: 0.01,
  };
  const decayRate = entry.decay_rate ?? defaultDecayRates[entry.category] ?? 0.02;

  db.prepare(`
    INSERT INTO knowledge (id, content, content_fts, category, tags, source_conversation, project, created_at, updated_at, importance, confidence, decay_rate, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, entry.content, contentFts, entry.category, tags,
    entry.source_conversation ?? null,
    entry.project ?? null,
    now, now,
    entry.importance ?? 0.5,
    entry.confidence ?? 0.7,
    decayRate,
    entry.expires_at ?? null
  );

  return {
    ...entry, id, tags: entry.tags ?? [],
    created_at: now, updated_at: now,
    access_count: 0, importance: entry.importance ?? 0.5,
    confidence: entry.confidence ?? 0.7,
    confirmed_count: 0,
    decay_rate: decayRate,
    last_confirmed_at: null,
    is_outdated: 0,
    impression_count: 0,
    adoption_count: 0,
    last_impression_at: null,
  };
}

export function getKnowledge(db: Database, id: string): KnowledgeEntry | null {
  const row = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id) as any;
  if (!row) return null;
  return rowToEntry(row);
}

export function updateKnowledge(
  db: Database,
  id: string,
  updates: Partial<Pick<KnowledgeEntry, "content" | "category" | "tags" | "source_conversation" | "project" | "importance">>
): KnowledgeEntry | null {
  const existing = getKnowledge(db, id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const content = updates.content ?? existing.content;
  const contentFts = preprocessChineseForFTS(content);
  const category = updates.category ?? existing.category;
  const tags = JSON.stringify(updates.tags ?? existing.tags);
  const source = updates.source_conversation !== undefined ? updates.source_conversation : existing.source_conversation;
  const project = updates.project !== undefined ? updates.project : existing.project;
  const importance = updates.importance ?? existing.importance;

  db.prepare(`
    UPDATE knowledge
    SET content = ?, content_fts = ?, category = ?, tags = ?, source_conversation = ?, project = ?,
        updated_at = ?, importance = ?, access_count = access_count + 1
    WHERE id = ?
  `).run(content, contentFts, category, tags, source ?? null, project ?? null, now, importance, id);

  return getKnowledge(db, id);
}

export function deleteKnowledge(db: Database, id: string): boolean {
  // CASCADE handles edges and embeddings
  const result = db.prepare("DELETE FROM knowledge WHERE id = ?").run(id);
  return result.changes > 0;
}

export function incrementAccess(db: Database, id: string): void {
  db.prepare("UPDATE knowledge SET access_count = access_count + 1 WHERE id = ?").run(id);
}

// === Usage tracking ===

export function recordImpressions(
  db: Database,
  knowledgeIds: string[],
  query: string
): void {
  if (knowledgeIds.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO usage_events (id, knowledge_id, event_type, query, created_at)
    VALUES (?, ?, 'impression', ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE knowledge
    SET impression_count = impression_count + 1, last_impression_at = ?
    WHERE id = ?
  `);
  for (const kid of knowledgeIds) {
    stmt.run(ulid(), kid, query, now);
    updateStmt.run(now, kid);
  }
}

export function recordAdoption(db: Database, knowledgeId: string, query: string | null): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO usage_events (id, knowledge_id, event_type, query, created_at)
    VALUES (?, ?, 'adoption', ?, ?)
  `).run(ulid(), knowledgeId, query, now);
  db.prepare(`
    UPDATE knowledge SET adoption_count = adoption_count + 1 WHERE id = ?
  `).run(knowledgeId);
}

export function recordRejection(db: Database, knowledgeId: string, query: string | null): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO usage_events (id, knowledge_id, event_type, query, created_at)
    VALUES (?, ?, 'rejection', ?, ?)
  `).run(ulid(), knowledgeId, query, now);
}

export function cleanupOldUsageEvents(db: Database, days: number = 90): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = db.prepare("DELETE FROM usage_events WHERE created_at < ?").run(cutoff);
  return Number(result.changes);
}

export function getUsageStats(db: Database, days: number = 30, topN: number = 10): UsageStats {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const impressionRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM usage_events WHERE event_type = 'impression' AND created_at >= ?"
  ).get(cutoff) as any;
  const total_impressions = impressionRow?.cnt ?? 0;

  const adoptionRow = db.prepare(
    "SELECT COUNT(*) as cnt FROM usage_events WHERE event_type = 'adoption' AND created_at >= ?"
  ).get(cutoff) as any;
  const total_adoptions = adoptionRow?.cnt ?? 0;

  const overall_adoption_rate = total_impressions > 0
    ? Math.round((total_adoptions / total_impressions) * 10000) / 10000
    : 0;

  // Top adopted: highest adoption_rate among those with impressions
  const topAdoptedRows = db.prepare(`
    SELECT * FROM knowledge
    WHERE impression_count > 0
    ORDER BY CAST(adoption_count AS REAL) / MAX(impression_count, 1) DESC, adoption_count DESC
    LIMIT ?
  `).all(...[topN]) as any[];
  const top_adopted = topAdoptedRows.map(rowToEntry);

  // Never adopted: impression_count > 5 but adoption_count = 0
  const neverAdoptedRows = db.prepare(`
    SELECT * FROM knowledge
    WHERE impression_count > 5 AND adoption_count = 0
    ORDER BY impression_count DESC
    LIMIT ?
  `).all(...[topN]) as any[];
  const never_adopted = neverAdoptedRows.map(rowToEntry);

  // Top queries
  const queryRows = db.prepare(`
    SELECT query, COUNT(*) as cnt
    FROM usage_events
    WHERE event_type = 'impression' AND created_at >= ? AND query IS NOT NULL AND query != ''
    GROUP BY query
    ORDER BY cnt DESC
    LIMIT ?
  `).all(cutoff, topN) as any[];
  const top_queries = queryRows.map((r: any) => ({ query: r.query, count: r.cnt }));

  return {
    period_days: days,
    total_impressions,
    total_adoptions,
    overall_adoption_rate,
    top_adopted,
    never_adopted,
    top_queries,
  };
}

// === Vector / Embedding operations (JS-based, no sqlite-vec) ===

export function insertVector(db: Database, knowledgeId: string, embedding: Float32Array): void {
  db.prepare("INSERT OR REPLACE INTO knowledge_embeddings (knowledge_id, embedding) VALUES (?, ?)").run(
    knowledgeId,
    serializeVector(embedding)
  );
}

export function deleteVector(db: Database, knowledgeId: string): void {
  db.prepare("DELETE FROM knowledge_embeddings WHERE knowledge_id = ?").run(knowledgeId);
}

export function getEmbedding(db: Database, knowledgeId: string): Float32Array | null {
  const row = db.prepare("SELECT embedding FROM knowledge_embeddings WHERE knowledge_id = ?").get(knowledgeId) as any;
  if (!row) return null;
  return deserializeVector(row.embedding as Buffer);
}

export function getAllEmbeddings(db: Database): Array<{ knowledge_id: string; embedding: Float32Array }> {
  const rows = db.prepare("SELECT knowledge_id, embedding FROM knowledge_embeddings").all() as any[];
  return rows.map((r: any) => ({
    knowledge_id: r.knowledge_id,
    embedding: deserializeVector(r.embedding as Buffer),
  }));
}

/**
 * JS-based KNN search. Computes cosine similarity against all stored embeddings,
 * returns top-k results. O(n) but fine for < 50K entries.
 */
export function searchVectorJS(
  db: Database,
  queryEmbedding: Float32Array,
  limit: number,
  filterCategory?: string,
  filterProject?: string,
): Array<{ knowledge_id: string; similarity: number }> {
  let rows: any[];

  if (filterCategory || filterProject) {
    // Build filtered query
    const conditions: string[] = [];
    const params: any[] = [];
    if (filterCategory) { conditions.push("k.category = ?"); params.push(filterCategory); }
    if (filterProject) { conditions.push("k.project = ?"); params.push(filterProject); }

    rows = db.prepare(`
      SELECT e.knowledge_id, e.embedding
      FROM knowledge_embeddings e
      JOIN knowledge k ON k.id = e.knowledge_id
      WHERE ${conditions.join(" AND ")}
    `).all(...params) as any[];
  } else {
    rows = db.prepare("SELECT knowledge_id, embedding FROM knowledge_embeddings").all() as any[];
  }

  if (rows.length === 0) return [];

  // Compute cosine similarity
  const results = rows.map((r: any) => {
    const emb = deserializeVector(r.embedding as Buffer);
    const sim = cosineSimilarity(queryEmbedding, emb);
    return { knowledge_id: r.knowledge_id, similarity: sim };
  });

  // Sort descending, take top-k
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

/**
 * Compute cosine similarity between two L2-normalized vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  // Clamp to [-1, 1] for floating-point safety
  return Math.max(-1, Math.min(1, dot));
}

// === Chinese text preprocessing for FTS ===

/**
 * Preprocess Chinese text for better FTS5 matching.
 * Splits continuous Chinese characters into 2-3 char segments.
 * Example: "数据库连接池" -> "数据 据库 库连 连接 接池"
 */
export function preprocessChineseForFTS(text: string): string {
  // Match continuous Chinese characters
  const chineseRegex = /[\u4e00-\u9fa5]+/g;
  const nonChineseRegex = /[^\u4e00-\u9fa5]+/g;

  let result = "";
  let lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = chineseRegex.exec(text)) !== null) {
    // Add non-Chinese part as-is
    if (match.index > lastIndex) {
      result += text.slice(lastIndex, match.index);
    }

    const chinese = match[0];
    // Generate 2-char and 3-char segments for better matching
    const segments: string[] = [];
    for (let i = 0; i < chinese.length; i++) {
      // 2-char segments
      if (i + 1 < chinese.length) {
        segments.push(chinese.slice(i, i + 2));
      }
      // 3-char segments (less frequent, for longer phrases)
      if (i + 2 < chinese.length && i % 2 === 0) {
        segments.push(chinese.slice(i, i + 3));
      }
    }

    result += " " + segments.join(" ") + " ";
    lastIndex = match.index + chinese.length;
  }

  // Add remaining non-Chinese part
  if (lastIndex < text.length) {
    result += text.slice(lastIndex);
  }

  return result.trim();
}

/**
 * Preprocess search query for FTS5.
 * For Chinese queries, generates multiple matching patterns.
 */
export function preprocessQueryForFTS(query: string): string {
  // Check if query contains Chinese
  const hasChinese = /[\u4e00-\u9fa5]/.test(query);

  if (!hasChinese) {
    // Pure non-Chinese query, use as-is
    return query;
  }

  // For Chinese queries, extract key terms and generate OR conditions
  const chineseParts = query.match(/[\u4e00-\u9fa5]+/g) || [];
  const nonChineseParts = query.match(/[^\u4e00-\u9fa5]+/g) || [];

  const terms: string[] = [];

  // Add Chinese character bigrams
  for (const part of chineseParts) {
    for (let i = 0; i < part.length - 1; i++) {
      terms.push(part.slice(i, i + 2));
    }
    // Also add single chars for fallback
    if (part.length === 1) {
      terms.push(part);
    }
  }

  // Add non-Chinese terms
  for (const part of nonChineseParts) {
    const trimmed = part.trim();
    if (trimmed) {
      terms.push(trimmed);
    }
  }

  // Remove duplicates and join with OR for broader matching
  const uniqueTerms = [...new Set(terms)];
  return uniqueTerms.join(" OR ");
}

// === FTS (Full-Text Search) ===

export interface FtsHit {
  rowid: number;
  rank: number;
}

export function searchFTS(db: Database, query: string, limit: number): FtsHit[] {
  // Preprocess query for better Chinese matching
  const processedQuery = preprocessQueryForFTS(query);

  // Clean and prepare FTS5 query
  // Don't wrap in quotes if it contains OR operators (from Chinese preprocessing)
  const hasOperators = processedQuery.includes(" OR ");
  const escaped = processedQuery.replace(/"/g, '""').replace(/[\*\^\(\)]/g, "");
  const ftsQuery = hasOperators ? escaped : `"${escaped}"`;

  try {
    const rows = db.prepare(`
      SELECT rowid, rank
      FROM knowledge_fts
      WHERE knowledge_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as any[];

    return rows.map((r: any) => ({ rowid: r.rowid, rank: r.rank }));
  } catch {
    // FTS5 query parse error (e.g. special chars). Return empty.
    return [];
  }
}

// === Graph operations ===

export function createEdge(db: Database, edge: Omit<KnowledgeEdge, "created_at">): KnowledgeEdge {
  const now = new Date().toISOString();
  const id = edge.id || ulid();

  // Check for duplicate first (better-sqlite3 doesn't throw on UNIQUE violation the same way)
  const exists = db.prepare(
    "SELECT id FROM knowledge_edges WHERE from_id = ? AND to_id = ? AND relationship = ?"
  ).get(edge.from_id, edge.to_id, edge.relationship);

  if (exists) {
    return { ...edge, id: (exists as any).id, created_at: now };
  }

  db.prepare(`
    INSERT INTO knowledge_edges (id, from_id, to_id, relationship, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, edge.from_id, edge.to_id, edge.relationship, now);

  return { ...edge, id, created_at: now };
}

export function getEdges(
  db: Database,
  knowledgeId: string,
  direction: "from" | "to" | "both" = "both"
): KnowledgeEdge[] {
  let rows: any[];

  if (direction === "from") {
    rows = db.prepare("SELECT * FROM knowledge_edges WHERE from_id = ?").all(knowledgeId) as any[];
  } else if (direction === "to") {
    rows = db.prepare("SELECT * FROM knowledge_edges WHERE to_id = ?").all(knowledgeId) as any[];
  } else {
    rows = db.prepare(
      "SELECT * FROM knowledge_edges WHERE from_id = ? OR to_id = ?"
    ).all(knowledgeId, knowledgeId) as any[];
  }

  return rows.map(rowToEdge);
}

export function deleteEdge(db: Database, id: string): boolean {
  const result = db.prepare("DELETE FROM knowledge_edges WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getRelatedKnowledge(
  db: Database,
  knowledgeId: string,
  maxRelated: number = 5
): Array<{ entry: KnowledgeEntry; relationship: RelationshipType; direction: "outgoing" | "incoming" }> {
  const rows = db.prepare(`
    SELECT * FROM knowledge_edges
    WHERE from_id = ? OR to_id = ?
    LIMIT ?
  `).all(knowledgeId, knowledgeId, maxRelated) as any[];

  return rows
    .map((e) => {
      const edge = rowToEdge(e);
      const relatedId = edge.from_id === knowledgeId ? edge.to_id : edge.from_id;
      const direction: "outgoing" | "incoming" = edge.from_id === knowledgeId ? "outgoing" : "incoming";
      const entry = getKnowledge(db, relatedId);
      if (!entry) return null;
      return { entry, relationship: edge.relationship, direction };
    })
    .filter(Boolean) as any[];
}

// === Statistics ===

export function getStats(db: Database): DatabaseStats {
  const totalEntries = (
    db.prepare("SELECT COUNT(*) as count FROM knowledge").get() as any
  ).count;

  const totalEdges = (
    db.prepare("SELECT COUNT(*) as count FROM knowledge_edges").get() as any
  ).count;

  const byCategory: Record<string, number> = {};
  const catRows = db.prepare(
    "SELECT category, COUNT(*) as count FROM knowledge GROUP BY category"
  ).all() as any[];
  for (const r of catRows) {
    byCategory[r.category] = r.count;
  }

  const byProject: Record<string, number> = {};
  const projRows = db.prepare(
    "SELECT project, COUNT(*) as count FROM knowledge WHERE project IS NOT NULL GROUP BY project"
  ).all() as any[];
  for (const r of projRows) {
    byProject[r.project] = r.count;
  }

  const lastUpdated = (
    db.prepare("SELECT MAX(updated_at) as last FROM knowledge").get() as any
  ).last;

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(defaultDbPath()).size;
  } catch {
    // In-memory or file not yet created
  }

  return {
    total_entries: totalEntries,
    total_edges: totalEdges,
    by_category: byCategory,
    by_project: byProject,
    db_size_bytes: dbSizeBytes,
    last_updated: lastUpdated ?? null,
  };
}

// === Bulk operations ===

export function getKnowledgeByIds(db: Database, ids: string[]): KnowledgeEntry[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM knowledge WHERE id IN (${placeholders})`
  ).all(...ids) as any[];
  return rows.map(rowToEntry);
}

export function getKnowledgeByRowids(db: Database, rowids: number[]): KnowledgeEntry[] {
  if (rowids.length === 0) return [];
  const placeholders = rowids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM knowledge WHERE rowid IN (${placeholders})`
  ).all(...rowids) as any[];
  return rows.map(rowToEntry);
}

// === Row deserialization helpers ===

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

function rowToEdge(row: any): KnowledgeEdge {
  return {
    id: row.id,
    from_id: row.from_id,
    to_id: row.to_id,
    relationship: row.relationship as RelationshipType,
    created_at: row.created_at,
  };
}
