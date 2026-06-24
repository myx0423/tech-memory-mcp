# AGENTS.md

This file provides guidance to AI coding agents when working with this codebase.

## Project Overview

tech-memory-mcp is a Model Context Protocol (MCP) Server that provides long-term technical knowledge memory for AI agents. It extracts, stores, and retrieves technical knowledge from conversations using vector embeddings and SQLite.

**Core purpose**: Enable AI assistants to remember "what was learned" across conversations, not just "what was said".

## Tech Stack

- **Runtime**: Node.js >= 18.0.0 (uses `better-sqlite3`)
- **Language**: TypeScript (strict mode, ES2022 target, NodeNext modules)
- **Database**: SQLite with FTS5 full-text search
- **Embeddings**: Transformers.js with `Xenova/jina-embeddings-v2-base-zh` (768-dim vectors)
- **MCP SDK**: `@modelcontextprotocol/sdk` for MCP protocol implementation
- **Build**: TypeScript compiler (`tsc`), no bundler

## Architecture

```
src/
├── index.ts              # MCP server entry point, registers all tools
├── db.ts                 # Database initialization, migrations, CRUD operations
├── embeddings.ts         # Vector embedding pipeline (Transformers.js)
├── types.ts              # Core type definitions
└── tools/                # MCP tool implementations
    ├── search.ts         # tech_search (hybrid vector + FTS search)
    ├── store.ts          # tech_store (store with semantic dedup)
    ├── auto_extract.ts   # tech_auto_extract (two-phase extraction)
    ├── extract.ts        # tech_extract_template (extraction prompt)
    ├── get.ts            # tech_get (retrieve single entry + graph neighbors)
    ├── link.ts           # tech_link (create knowledge relationships)
    ├── confirm.ts        # tech_confirm (adjust confidence)
    ├── decay.ts          # tech_decay (age-based confidence decay)
    ├── outdated.ts       # tech_outdated (query expired entries)
    └── stats.ts          # tech_stats (database statistics)
```

## Key Patterns

### Adding a New MCP Tool

1. Create `src/tools/<tool_name>.ts`
2. Export a `register<ToolName>Tool(server: McpServer, db: DatabaseSync)` function
3. Use `server.registerTool()` with:
   - `description`: Chinese description explaining what the tool does
   - `inputSchema`: Zod schema with `.strict()` to reject unknown fields
   - Handler: async function returning `{ content: [{ type: "text", text: string }] }`
4. Register the tool in `src/index.ts` by calling the register function
5. All logging goes to `process.stderr` (stdout is reserved for MCP JSON-RPC)

### Database Operations

- Use `getDatabase()` to get the singleton `DatabaseSync` instance
- All queries use prepared statements: `db.prepare(sql).run(...)` or `.get(...)` or `.all(...)`
- Row deserialization: use helper functions like `rowToEntry()` in `db.ts`
- Migrations: add new migration function `migrate_vN()` and call it in `initDatabase()` if `currentVersion < N`
- Increment `PRAGMA user_version` after each migration

### Knowledge Entry Lifecycle

```
insertKnowledge() → store entry with metadata
  ↓
getSingleEmbedding() → compute 768-dim vector
  ↓
insertVector() → store vector in knowledge_embeddings table
  ↓
searchVectorJS() → semantic search using cosine similarity
  ↓
updateKnowledge() → update entry (e.g., on dedup match)
  ↓
incrementAccess() → track usage
  ↓
decay logic → reduce confidence over time based on decay_rate
```

### Semantic Deduplication

When storing new knowledge:
1. Compute embedding for new content
2. Search top-5 nearest neighbors using `searchVectorJS()`
3. If similarity >= `dedup_threshold` (default 0.85), update existing entry instead of creating new one
4. Use `cosineSimilarity()` for comparison (vectors are L2-normalized)

### Chinese Text Processing

- `preprocessChineseForFTS()`: splits continuous Chinese into 2-3 char segments for better FTS5 matching
- `preprocessQueryForFTS()`: expands Chinese queries with OR conditions for broader matching
- Example: "数据库连接池" → "数据 据库 库连 连接 接池"

## Code Conventions

### TypeScript

- **Strict mode enabled**: no implicit any, no unchecked types
- **ESM modules**: use `import`/`export`, file extensions required (`.js` in imports)
- **Type imports**: use `import type { ... }` for type-only imports
- **Zod schemas**: use `.strict()` on all input schemas to reject unknown fields
- **Error handling**: catch errors, log to stderr, return `{ isError: true, content: [...] }`

### Naming

- **Files**: snake_case (e.g., `auto_extract.ts`)
- **Functions**: camelCase (e.g., `insertKnowledge`)
- **Types**: PascalCase for interfaces/types (e.g., `KnowledgeEntry`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `RRF_K = 60`)
- **Database columns**: snake_case (e.g., `created_at`)

### Logging

- All logs go to `process.stderr` with prefix `[tech-memory]` or `[tool_name]`
- Use `log()` helper function defined in each module
- Never log to stdout (reserved for MCP JSON-RPC)

### Return Format

All MCP tools return:
```typescript
{
  content: [
    {
      type: "text" as const,
      text: string // JSON.stringify(result, null, 2) or plain text
    }
  ]
}
```

For errors:
```typescript
{
  isError: true,
  content: [{ type: "text", text: "❌ Error message..." }]
}
```

## Database Schema

### knowledge table
- `id`: ULID (unique identifier)
- `content`: knowledge text (Chinese preferred)
- `content_fts`: preprocessed text for FTS5
- `category`: enum (decision/lesson/preference/fact/pattern)
- `tags`: JSON array of strings
- `project`: optional project name
- `importance`: 0.0-1.0
- `confidence`: 0.0-1.0 (decays over time)
- `decay_rate`: per-category default (fact=0.05, lesson=0.01, etc.)
- `is_outdated`: 0 or 1
- `expires_at`: optional ISO 8601 timestamp

### knowledge_embeddings table
- `knowledge_id`: FK to knowledge.id
- `embedding`: BLOB (768-dim Float32Array, 3072 bytes)

### knowledge_edges table
- `from_id`, `to_id`: FK to knowledge.id
- `relationship`: enum (related/depends_on/supersedes/contradicts)

## Testing

- Test framework: Node.js built-in `node:test`
- Run tests: `npm test`
- Test files: `test/*.test.ts`
- Use `tsx` for TypeScript execution

## Build & Development

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled server (node dist/index.js)
npm test             # Run tests
```

**Important**: After building, the `postbuild` script copies `src/prompts/*.md` to `dist/prompts/`.

## Common Tasks

### Add a new knowledge category
1. Update `KnowledgeCategory` type in `src/types.ts`
2. Update CHECK constraint in `src/db.ts` migration
3. Update category labels in tool descriptions
4. Add default `decay_rate` in `insertKnowledge()` and `getDefaultDecayRate()`

### Modify database schema
1. Create new migration function `migrate_vN()` in `src/db.ts`
2. Use `ALTER TABLE` or recreate table with new schema
3. Update `PRAGMA user_version = N`
4. Call migration in `initDatabase()` if `currentVersion < N`

### Add CLI command
1. Create `src/cli.ts` with argument parsing
2. Add script to `package.json`
3. Use `process.argv` for simple commands (no heavy CLI framework)

## Performance Considerations

- **Vector search**: O(n) brute-force cosine similarity, acceptable for < 50K entries
- **Batch operations**: process in chunks to avoid memory issues (e.g., 1000+ entries)
- **Embedding computation**: async/await, model loads lazily on first use
- **FTS5**: automatic sync via triggers, no manual index updates needed

## MCP Protocol

- Server communicates via stdio (JSON-RPC)
- All tool responses must be JSON-serializable
- Use `McpServer` from `@modelcontextprotocol/sdk`
- Register tools before calling `server.connect(transport)`

## Language Preferences

- **Code comments**: English or Chinese (project uses Chinese for user-facing strings)
- **User-facing messages**: Chinese (e.g., "✅ 知识已存储", "❌ 搜索失败")
- **Log messages**: Chinese preferred for consistency
- **Type names**: English (e.g., `KnowledgeEntry`, not `知识条目`)
