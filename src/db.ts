import { DatabaseSync } from "node:sqlite";
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
  return Buffer.from(vec.buffer);
}

export function deserializeVector(buf: Buffer): Float32Array {
  return new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

// === Database initialization ===
let _db: DatabaseSync | null = null;

export function initDatabase(dbPath?: string): DatabaseSync {
  if (_db) return _db;

  const path = dbPath ?? defaultDbPath();
  log(`打开数据库: ${path}`);

  const db = new DatabaseSync(path);

  // Enable WAL mode and foreign keys
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Run migrations
  const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const currentVersion = versionRow?.user_version ?? 0;
  log(`DB schema version: ${currentVersion}`);

  if (currentVersion < 1) {
    migrate_v1(db);
  }

  _db = db;
  return db;
}

export function getDatabase(): DatabaseSync {
  if (!_db) throw new Error("数据库未初始化，请先调用 initDatabase()");
  return _db;
}

// === Migration: v1 (initial schema) ===
function migrate_v1(db: DatabaseSync): void {
  log("执行迁移 v1: 初始 schema");

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
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
      content,
      tags,
      content=knowledge,
      content_rowid=rowid
    );

    -- FTS5 sync triggers
    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
      INSERT INTO knowledge_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
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

// === Knowledge CRUD ===

export function insertKnowledge(
  db: DatabaseSync,
  entry: Omit<KnowledgeEntry, "created_at" | "updated_at" | "access_count">
): KnowledgeEntry {
  const now = new Date().toISOString();
  const id = entry.id || ulid();
  const tags = JSON.stringify(entry.tags ?? []);

  db.prepare(`
    INSERT INTO knowledge (id, content, category, tags, source_conversation, project, created_at, updated_at, importance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, entry.content, entry.category, tags,
    entry.source_conversation ?? null,
    entry.project ?? null,
    now, now,
    entry.importance ?? 0.5
  );

  return {
    ...entry, id, tags: entry.tags ?? [],
    created_at: now, updated_at: now,
    access_count: 0, importance: entry.importance ?? 0.5,
  };
}

export function getKnowledge(db: DatabaseSync, id: string): KnowledgeEntry | null {
  const row = db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id) as any;
  if (!row) return null;
  return rowToEntry(row);
}

export function updateKnowledge(
  db: DatabaseSync,
  id: string,
  updates: Partial<Pick<KnowledgeEntry, "content" | "category" | "tags" | "source_conversation" | "project" | "importance">>
): KnowledgeEntry | null {
  const existing = getKnowledge(db, id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const content = updates.content ?? existing.content;
  const category = updates.category ?? existing.category;
  const tags = JSON.stringify(updates.tags ?? existing.tags);
  const source = updates.source_conversation !== undefined ? updates.source_conversation : existing.source_conversation;
  const project = updates.project !== undefined ? updates.project : existing.project;
  const importance = updates.importance ?? existing.importance;

  db.prepare(`
    UPDATE knowledge
    SET content = ?, category = ?, tags = ?, source_conversation = ?, project = ?,
        updated_at = ?, importance = ?, access_count = access_count + 1
    WHERE id = ?
  `).run(content, category, tags, source ?? null, project ?? null, now, importance, id);

  return getKnowledge(db, id);
}

export function deleteKnowledge(db: DatabaseSync, id: string): boolean {
  // CASCADE handles edges and embeddings
  const result = db.prepare("DELETE FROM knowledge WHERE id = ?").run(id);
  return result.changes > 0;
}

export function incrementAccess(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE knowledge SET access_count = access_count + 1 WHERE id = ?").run(id);
}

// === Vector / Embedding operations (JS-based, no sqlite-vec) ===

export function insertVector(db: DatabaseSync, knowledgeId: string, embedding: Float32Array): void {
  db.prepare("INSERT OR REPLACE INTO knowledge_embeddings (knowledge_id, embedding) VALUES (?, ?)").run(
    knowledgeId,
    serializeVector(embedding)
  );
}

export function deleteVector(db: DatabaseSync, knowledgeId: string): void {
  db.prepare("DELETE FROM knowledge_embeddings WHERE knowledge_id = ?").run(knowledgeId);
}

export function getEmbedding(db: DatabaseSync, knowledgeId: string): Float32Array | null {
  const row = db.prepare("SELECT embedding FROM knowledge_embeddings WHERE knowledge_id = ?").get(knowledgeId) as any;
  if (!row) return null;
  return deserializeVector(row.embedding as Buffer);
}

export function getAllEmbeddings(db: DatabaseSync): Array<{ knowledge_id: string; embedding: Float32Array }> {
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
  db: DatabaseSync,
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

// === FTS (Full-Text Search) ===

export interface FtsHit {
  rowid: number;
  rank: number;
}

export function searchFTS(db: DatabaseSync, query: string, limit: number): FtsHit[] {
  // Clean and prepare FTS5 query
  const escaped = query.replace(/"/g, '""').replace(/[\*\^\(\)]/g, "");
  // Use prefix matching for Chinese substrings
  const ftsQuery = `"${escaped}"`;

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

export function createEdge(db: DatabaseSync, edge: Omit<KnowledgeEdge, "created_at">): KnowledgeEdge {
  const now = new Date().toISOString();
  const id = edge.id || ulid();

  // Check for duplicate first (node:sqlite doesn't throw on UNIQUE violation the same way)
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
  db: DatabaseSync,
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

export function deleteEdge(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM knowledge_edges WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getRelatedKnowledge(
  db: DatabaseSync,
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

export function getStats(db: DatabaseSync): DatabaseStats {
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

export function getKnowledgeByIds(db: DatabaseSync, ids: string[]): KnowledgeEntry[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT * FROM knowledge WHERE id IN (${placeholders})`
  ).all(...ids) as any[];
  return rows.map(rowToEntry);
}

export function getKnowledgeByRowids(db: DatabaseSync, rowids: number[]): KnowledgeEntry[] {
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
