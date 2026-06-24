// === Knowledge Types ===

export type KnowledgeCategory =
  | "decision"   // 技术决策：为什么选 A 不选 B
  | "lesson"     // 经验教训：踩过的坑、排过的雷
  | "preference" // 个人偏好：用户习惯、工作流倾向
  | "fact"       // 技术事实：配置参数、版本兼容性
  | "pattern";   // 通用模式：可复用的架构/解决方案

export type RelationshipType =
  | "related"      // 相关
  | "depends_on"   // 前置依赖
  | "supersedes"   // 替代旧知识
  | "contradicts"; // 相互矛盾（待审查）

export interface KnowledgeEntry {
  id: string;                // ULID
  content: string;           // 知识要点（中文为主）
  category: KnowledgeCategory;
  tags: string[];            // 标签
  source_conversation?: string; // 来源对话引用
  project?: string;          // 来源项目
  created_at: string;        // ISO 8601
  updated_at: string;        // ISO 8601
  access_count: number;      // 被检索次数
  importance: number;        // 0.0 ~ 1.0
  confidence: number;        // 置信度 0.0 ~ 1.0
  confirmed_count: number;   // 被确认有用的次数
  decay_rate: number;        // 衰减速率
  last_confirmed_at: string | null;  // ISO 8601
  expires_at: string | null; // ISO 8601
  is_outdated: number;       // 0 或 1
  impression_count: number;  // 被搜索返回的次数
  adoption_count: number;    // 被实际采用的次数
  last_impression_at: number | null; // Unix 时间戳
}

export interface KnowledgeEdge {
  id: string;
  from_id: string;
  to_id: string;
  relationship: RelationshipType;
  created_at: string;
}

export interface SearchResult {
  entry: KnowledgeEntry;
  score: number;             // RRF 融合分数
  vector_rank?: number;      // 向量搜索排名
  fts_rank?: number;         // 全文搜索排名
  confidence: number;        // 置信度
  is_outdated: boolean;      // 是否已过期
}

export interface DedupResult {
  matched: boolean;
  existing_id?: string;
  similarity: number;
}

export interface DatabaseStats {
  total_entries: number;
  total_edges: number;
  by_category: Record<string, number>;
  by_project: Record<string, number>;
  db_size_bytes: number;
  last_updated: string | null;
}

// === Usage Tracking Types ===

export type UsageEventType = "impression" | "adoption" | "rejection";

export interface UsageEvent {
  id: string;
  knowledge_id: string;
  event_type: UsageEventType;
  query: string | null;
  created_at: number;        // Unix 时间戳
}

export interface UsageStats {
  period_days: number;
  total_impressions: number;
  total_adoptions: number;
  overall_adoption_rate: number;
  top_adopted: KnowledgeEntry[];
  never_adopted: KnowledgeEntry[];
  top_queries: { query: string; count: number }[];
}

// === Extraction Types ===

export interface ExtractedKnowledgeItem {
  content: string;
  category: KnowledgeCategory;
  tags?: string[];
  project?: string;
  importance?: number;
}

export interface ExtractionTemplate {
  prompt: string;
  json_schema: object;
  instructions: string;
}
