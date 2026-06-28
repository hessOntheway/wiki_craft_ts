import * as fssync from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig, WorkspacePaths } from "../types.ts";
import { EmbeddingClient, embeddingsEnabled, embeddingSignature } from "../knowledge/embeddings.ts";
import type { GraphEdge, SearchChunk, SearchIndexCache, SearchIndexErrorEvent, SearchIndexEvent, SearchImportMode, SearchIndexAction } from "../knowledge/model.ts";
import { normalizeGraphText } from "../knowledge/text.ts";
import { appendJsonl, ensureDir, nowMs, sha256Hex, writeJson } from "../util.ts";

export class KnowledgeIndexStore {
  private readonly paths: WorkspacePaths;
  private readonly settings: AppConfig["search"];
  private readonly embeddingClient: EmbeddingClient;

  constructor(paths: WorkspacePaths, settings: AppConfig["search"], embeddingClient = new EmbeddingClient(settings)) {
    this.paths = paths;
    this.settings = settings;
    this.embeddingClient = embeddingClient;
  }

  get knowledgeRoot(): string {
    return this.paths.knowledgeCurrent;
  }

  async refresh(chunks: SearchChunk[], options: { lexicalOnly?: boolean; force?: boolean } = {}): Promise<SearchIndexCache> {
  const paths = this.paths;
  const settings = this.settings;
  const lexicalOnly = options.lexicalOnly ?? false;
  const force = options.force ?? true;
  const fingerprint = sha256Hex(JSON.stringify(chunks.map((chunk) => [chunk.id, sha256Hex(chunk.body)])));
  const enabled = embeddingsEnabled(settings);
  const signature = enabled ? embeddingSignature(settings) : null;
  const events = syncSqliteIndex(paths.searchIndexPath, chunks, fingerprint, force, paths.searchEventsPath, paths.searchErrorsPath, lexicalOnly || !enabled);
  if (lexicalOnly || !enabled) clearSqliteEmbeddings(paths.searchIndexPath);
  let warning: string | null = null;
  if (enabled && !lexicalOnly) {
    const changedIds = new Set(events.filter((event) => event.action === "add" || event.action === "update").map((event) => event.chunk_id));
    for (const chunk of chunks) {
      const state = sqliteEmbeddingState(paths.searchIndexPath, chunk.id);
      if (!changedIds.has(chunk.id) && state.embedding_signature === signature && state.embedding) continue;
      if (state.embedding && state.embedding_signature === signature) continue;
      try {
        persistSqliteEmbedding(paths.searchIndexPath, chunk.id, await this.embeddingClient.embed(embeddableText(chunk)), signature!);
      } catch (error) {
        warning = `embedding unavailable; using BM25 fallback: ${error instanceof Error ? error.message : String(error)}`;
        persistSqliteEmbeddingError(paths.searchIndexPath, chunk.id, warning, signature);
        const event = events.find((item) => item.chunk_id === chunk.id);
        await appendSearchIndexError(paths.searchErrorsPath, {
          schema_version: 1,
          run_id: event?.run_id ?? `knowledge-index-${nowMs()}`,
          event_id: event?.event_id,
          ts_unix_ms: nowMs(),
          stage: "vector",
          chunk_id: chunk.id,
          action: event?.action,
          error: warning,
        });
        break;
      }
    }
  }
  const rows = sqliteIndexRows(paths.searchIndexPath, settings.embedding_dimensions, signature);
  const cache: SearchIndexCache = {
    schema_version: 1,
    fingerprint,
    chunks: rows.map((row) => ({ id: row.chunk_id, hash: row.content_hash, embedding: row.embedding ?? undefined })),
    embedding_signature: signature,
    embedding_warning: warning ?? rows.find((row) => row.embedding_error)?.embedding_error ?? null,
    stale_vectors: rows.filter((row) => row.embedding_signature && row.embedding_signature !== signature).length,
    graph_edges: sqliteGraphEdgeCount(paths.searchIndexPath),
  };
  await ensureDir(path.dirname(paths.searchCachePath));
  await writeJson(paths.searchCachePath, cache);
  return cache;
}

}

async function appendSearchIndexError(file: string, event: SearchIndexErrorEvent): Promise<void> {
  try {
    await appendJsonl(file, event);
  } catch {
    // Search should remain available even when error logging fails.
  }
}

function appendJsonlSync(file: string, value: unknown): void {
  ensureDirSync(path.dirname(file));
  fssync.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function syncSqliteIndex(sqlitePath: string, chunks: SearchChunk[], fingerprint: string, force: boolean, eventsPath: string, errorsPath: string, skipVector: boolean): SearchIndexEvent[] {
  ensureDirSync(path.dirname(sqlitePath));
  const db = new DatabaseSync(sqlitePath);
  const runId = `reindex-${nowMs()}`;
  try {
    ensureSearchSchema(db);
    const current = db.prepare("SELECT value FROM search_meta WHERE key = 'vault_fingerprint'").get() as { value?: string } | undefined;
    if (!force && current?.value === fingerprint) return [];
    const oldRows = loadIndexedChunkState(db);
    const events = diffSearchIndexEvents(runId, oldRows, chunks, skipVector);
    if (events.length === 0) {
      db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('schema_version', '1')").run();
      db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('vault_fingerprint', ?)").run(fingerprint);
      return [];
    }
    try {
      for (const event of events) appendJsonlSync(eventsPath, event);
    } catch (error) {
      appendJsonlSync(errorsPath, {
        schema_version: 1,
        run_id: runId,
        ts_unix_ms: nowMs(),
        stage: "event_log",
        error: error instanceof Error ? error.message : String(error),
      } satisfies SearchIndexErrorEvent);
      throw error;
    }
    try {
      db.exec("BEGIN");
      const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
      for (const event of events) applyChunkIndexEvent(db, event, byId.get(event.chunk_id));
      rebuildFtsIndex(db);
      db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('schema_version', '1')").run();
      db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('vault_fingerprint', ?)").run(fingerprint);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Best effort rollback only.
      }
      appendJsonlSync(errorsPath, {
        schema_version: 1,
        run_id: runId,
        ts_unix_ms: nowMs(),
        stage: "keyword",
        error: error instanceof Error ? error.message : String(error),
      } satisfies SearchIndexErrorEvent);
      throw error;
    }
    return events;
  } finally {
    db.close();
  }
}

function loadIndexedChunkState(db: DatabaseSync): Map<string, { content_hash: string; path: string; heading?: string | null }> {
  const rows = db.prepare("SELECT chunk_id, content_hash, heading FROM search_chunks ORDER BY chunk_id").all() as Array<{ chunk_id: string; content_hash: string; heading?: string | null }>;
  return new Map(rows.map((row) => [row.chunk_id, { content_hash: row.content_hash, path: row.chunk_id.split("#")[0] ?? row.chunk_id, heading: row.heading ?? null }]));
}

function diffSearchIndexEvents(runId: string, oldRows: Map<string, { content_hash: string; path: string; heading?: string | null }>, chunks: SearchChunk[], skipVector: boolean): SearchIndexEvent[] {
  const mode: SearchImportMode = oldRows.size === 0 ? "full" : "incremental";
  const now = nowMs();
  const events: SearchIndexEvent[] = [];
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  for (const chunk of chunks) {
    const old = oldRows.get(chunk.id);
    const nextHash = sha256Hex(chunk.body);
    if (!old) {
      events.push(searchIndexEvent({ runId, mode, ts: now, action: "add", chunk, oldHash: null, newHash: nextHash, skipVector }));
    } else if (old.content_hash !== nextHash) {
      events.push(searchIndexEvent({ runId, mode, ts: now, action: "update", chunk, oldHash: old.content_hash, newHash: nextHash, skipVector }));
    }
  }
  for (const [id, old] of oldRows) {
    if (byId.has(id)) continue;
    events.push(searchIndexEvent({ runId, mode, ts: now, action: "delete", oldChunk: { id, path: old.path, heading: old.heading }, oldHash: old.content_hash, newHash: null, skipVector }));
  }
  return events.sort((left, right) => left.chunk_id.localeCompare(right.chunk_id) || left.action.localeCompare(right.action));
}

function searchIndexEvent(input: {
  runId: string;
  mode: SearchImportMode;
  ts: number;
  action: SearchIndexAction;
  chunk?: SearchChunk;
  oldChunk?: { id: string; path: string; heading?: string | null };
  oldHash: string | null;
  newHash: string | null;
  skipVector: boolean;
}): SearchIndexEvent {
  const chunkId = input.chunk?.id ?? input.oldChunk!.id;
  const pagePath = input.chunk?.displayPath ?? input.oldChunk!.path;
  const heading = input.chunk?.heading ?? input.oldChunk?.heading ?? null;
  const keyword = input.action === "update" ? ["delete", "add"] as SearchIndexAction[] : [input.action];
  const vector = input.skipVector ? [] : keyword;
  const graph = keyword;
  return {
    schema_version: 1,
    event_id: sha256Hex(`${input.runId}\0${input.action}\0${chunkId}\0${input.oldHash ?? ""}\0${input.newHash ?? ""}`),
    run_id: input.runId,
    import_mode: input.mode,
    ts_unix_ms: input.ts,
    action: input.action,
    chunk_id: chunkId,
    page_path: pagePath,
    heading,
    old_content_hash: input.oldHash,
    new_content_hash: input.newHash,
    unit_hash: input.chunk?.version_hashes[0] ?? null,
    source_refs: input.chunk ? [...input.chunk.source_urls, ...input.chunk.source_ids] : [],
    index_ops: { keyword, vector, graph },
  };
}

function applyChunkIndexEvent(db: DatabaseSync, event: SearchIndexEvent, chunk?: SearchChunk): void {
  if (event.action === "delete") {
    deleteChunkIndexes(db, event.chunk_id);
    return;
  }
  if (!chunk) throw new Error(`missing chunk for ${event.action} event: ${event.chunk_id}`);
  if (event.action === "update") deleteChunkIndexes(db, event.chunk_id);
  addChunkIndexes(db, chunk);
}

function deleteChunkIndexes(db: DatabaseSync, chunkId: string): void {
  db.prepare("DELETE FROM search_graph_edges WHERE chunk_id = ?").run(chunkId);
  db.prepare("DELETE FROM search_chunks WHERE chunk_id = ?").run(chunkId);
}

function addChunkIndexes(db: DatabaseSync, chunk: SearchChunk): void {
  const contentHash = sha256Hex(chunk.body);
  db.prepare(`INSERT INTO search_chunks (
    chunk_id, content_hash, display_path, relative_path, kind, title, aliases, tags, wikilinks,
    source_ids, source_urls, version_hashes, updated_at_run_id, heading, body, line_start, embeddable_text,
    embedding, embedding_signature, embedding_error
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`).run(
    chunk.id,
    contentHash,
    chunk.displayPath,
    chunk.relativePath,
    chunk.kind,
    chunk.title ?? "",
    chunk.aliases.join(" "),
    chunk.tags.join(" "),
    chunk.wikilinks.join(" "),
    JSON.stringify(chunk.source_ids),
    JSON.stringify(chunk.source_urls),
    JSON.stringify(chunk.version_hashes),
    chunk.updated_at_run_id ?? null,
    chunk.heading ?? "",
    chunk.body,
    chunk.lineStart,
    embeddableText(chunk),
  );
  insertGraphEdgesForChunk(db, chunk, contentHash);
}

function insertGraphEdgesForChunk(db: DatabaseSync, chunk: SearchChunk, contentHash: string): void {
  const insert = db.prepare(`INSERT OR REPLACE INTO search_graph_edges (
    edge_id, chunk_id, document_id, subject, predicate, object,
    subject_norm, predicate_norm, object_norm,
    evidence_count, content_hash, attrs_json, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const edge of graphEdgesForChunk(chunk, contentHash)) {
    insert.run(
      graphEdgeId(edge),
      edge.chunk_id,
      edge.document_id,
      edge.subject,
      edge.predicate,
      edge.object,
      normalizeGraphText(edge.subject),
      normalizeGraphText(edge.predicate),
      normalizeGraphText(edge.object),
      edge.evidence_count,
      edge.content_hash,
      edge.attrs_json,
      edge.updated_at,
    );
  }
}

function ensureSearchSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS search_chunks (
  chunk_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  display_path TEXT NOT NULL DEFAULT '',
  relative_path TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'topic',
  title TEXT NOT NULL,
  aliases TEXT NOT NULL,
  tags TEXT NOT NULL,
  wikilinks TEXT NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]',
  source_urls TEXT NOT NULL DEFAULT '[]',
  version_hashes TEXT NOT NULL DEFAULT '[]',
  updated_at_run_id TEXT,
  heading TEXT NOT NULL,
  body TEXT NOT NULL,
  line_start INTEGER NOT NULL DEFAULT 1,
  embeddable_text TEXT NOT NULL,
  embedding BLOB,
  embedding_signature TEXT,
  embedding_error TEXT
);
CREATE TABLE IF NOT EXISTS search_graph_edges (
  edge_id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  subject_norm TEXT NOT NULL,
  predicate_norm TEXT NOT NULL,
  object_norm TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  attrs_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_graph_chunk ON search_graph_edges(chunk_id);
CREATE INDEX IF NOT EXISTS idx_search_graph_subject ON search_graph_edges(subject_norm);
CREATE INDEX IF NOT EXISTS idx_search_graph_object ON search_graph_edges(object_norm);
CREATE INDEX IF NOT EXISTS idx_search_graph_predicate ON search_graph_edges(predicate_norm);`);
  const columns = new Set((db.prepare("PRAGMA table_info(search_chunks)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("embedding") || !columns.has("embedding_signature") || !columns.has("embedding_error")) {
    db.exec("DROP TABLE IF EXISTS search_chunks_fts; DROP TABLE IF EXISTS search_chunks; DROP TABLE IF EXISTS search_meta;");
    ensureSearchSchema(db);
    return;
  }
  const addedMetadataColumn = [
    addSearchChunkColumn(db, columns, "display_path", "TEXT NOT NULL DEFAULT ''"),
    addSearchChunkColumn(db, columns, "relative_path", "TEXT NOT NULL DEFAULT ''"),
    addSearchChunkColumn(db, columns, "kind", "TEXT NOT NULL DEFAULT 'topic'"),
    addSearchChunkColumn(db, columns, "source_ids", "TEXT NOT NULL DEFAULT '[]'"),
    addSearchChunkColumn(db, columns, "source_urls", "TEXT NOT NULL DEFAULT '[]'"),
    addSearchChunkColumn(db, columns, "version_hashes", "TEXT NOT NULL DEFAULT '[]'"),
    addSearchChunkColumn(db, columns, "updated_at_run_id", "TEXT"),
    addSearchChunkColumn(db, columns, "line_start", "INTEGER NOT NULL DEFAULT 1"),
  ].some(Boolean);
  if (addedMetadataColumn) db.prepare("UPDATE search_chunks SET content_hash = ''").run();
}

function addSearchChunkColumn(db: DatabaseSync, columns: Set<string>, name: string, definition: string): boolean {
  if (columns.has(name)) return false;
  db.exec(`ALTER TABLE search_chunks ADD COLUMN ${name} ${definition}`);
  columns.add(name);
  return true;
}

function rebuildGraphIndex(db: DatabaseSync, chunks: SearchChunk[]): void {
  db.exec("DELETE FROM search_graph_edges;");
  const insert = db.prepare(`INSERT OR REPLACE INTO search_graph_edges (
    edge_id, chunk_id, document_id, subject, predicate, object,
    subject_norm, predicate_norm, object_norm,
    evidence_count, content_hash, attrs_json, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const chunk of chunks) {
    const contentHash = sha256Hex(chunk.body);
    for (const edge of graphEdgesForChunk(chunk, contentHash)) {
      insert.run(
        graphEdgeId(edge),
        edge.chunk_id,
        edge.document_id,
        edge.subject,
        edge.predicate,
        edge.object,
        normalizeGraphText(edge.subject),
        normalizeGraphText(edge.predicate),
        normalizeGraphText(edge.object),
        edge.evidence_count,
        edge.content_hash,
        edge.attrs_json,
        edge.updated_at,
      );
    }
  }
}

function graphEdgesForChunk(chunk: SearchChunk, contentHash: string): GraphEdge[] {
  const now = new Date().toISOString();
  const attrs = JSON.stringify({ kind: chunk.kind, path: chunk.displayPath, heading: chunk.heading ?? null });
  const edges: GraphEdge[] = [];
  const push = (edgeSubject: string, predicate: string, object: string) => {
    const normalizedSubject = edgeSubject.trim();
    const normalizedObject = object.trim();
    if (!normalizedSubject || !normalizedObject) return;
    edges.push({
      chunk_id: chunk.id,
      document_id: chunk.displayPath,
      subject: normalizedSubject,
      predicate,
      object: normalizedObject,
      evidence_count: 1,
      content_hash: contentHash,
      attrs_json: attrs,
      updated_at: now,
    });
  };
  for (const edge of chunk.graph_edges) push(edge.subject, edge.predicate, edge.object);
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.chunk_id}\0${edge.subject}\0${edge.predicate}\0${edge.object}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function graphEdgeId(edge: GraphEdge): string {
  return sha256Hex(`${edge.chunk_id}\0${edge.subject}\0${edge.predicate}\0${edge.object}`);
}

function graphEdgeCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM search_graph_edges").get() as { count: number };
  return row.count;
}

function sqliteGraphEdgeCount(sqlitePath: string): number {
  const db = new DatabaseSync(sqlitePath);
  try {
    ensureSearchSchema(db);
    return graphEdgeCount(db);
  } finally {
    db.close();
  }
}

function rebuildFtsIndex(db: DatabaseSync): void {
  try {
    db.exec(`DROP TABLE IF EXISTS search_chunks_fts;
CREATE VIRTUAL TABLE search_chunks_fts USING fts5(
  title, aliases, tags, wikilinks, heading, body,
  content='search_chunks', content_rowid='rowid',
  tokenize='porter unicode61', prefix='2 3 4'
);
INSERT INTO search_chunks_fts(rowid, title, aliases, tags, wikilinks, heading, body)
  SELECT rowid, title, aliases, tags, wikilinks, heading, body FROM search_chunks;`);
    db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('fts5_available', 'true')").run();
  } catch (error) {
    try {
      db.exec("DROP TABLE IF EXISTS search_chunks_fts;");
    } catch {
      // FTS5 may be unavailable even for DROP; BM25 fallback can use in-memory scoring.
    }
    db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('fts5_available', 'false')").run();
    db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('fts5_error', ?)").run(error instanceof Error ? error.message : String(error));
  }
}

function sqliteEmbeddingState(sqlitePath: string, chunkId: string): { embedding: number[] | null; embedding_signature: string | null; embedding_error: string | null } {
  const db = new DatabaseSync(sqlitePath);
  try {
    const row = db.prepare("SELECT embedding, embedding_signature, embedding_error FROM search_chunks WHERE chunk_id = ?").get(chunkId) as { embedding?: Buffer | null; embedding_signature?: string | null; embedding_error?: string | null } | undefined;
    return { embedding: decodeEmbedding(row?.embedding ?? null), embedding_signature: row?.embedding_signature ?? null, embedding_error: row?.embedding_error ?? null };
  } finally {
    db.close();
  }
}

function persistSqliteEmbedding(sqlitePath: string, chunkId: string, embedding: number[], signature: string): void {
  const db = new DatabaseSync(sqlitePath);
  try {
    db.prepare("UPDATE search_chunks SET embedding = ?, embedding_signature = ?, embedding_error = NULL WHERE chunk_id = ?").run(encodeEmbedding(embedding), signature, chunkId);
  } finally {
    db.close();
  }
}

function persistSqliteEmbeddingError(sqlitePath: string, chunkId: string, error: string, signature: string | null): void {
  const db = new DatabaseSync(sqlitePath);
  try {
    db.prepare("UPDATE search_chunks SET embedding_error = ?, embedding_signature = ? WHERE chunk_id = ?").run(error, signature, chunkId);
  } finally {
    db.close();
  }
}

function clearSqliteEmbeddings(sqlitePath: string): void {
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec("UPDATE search_chunks SET embedding = NULL, embedding_signature = NULL, embedding_error = NULL");
  } finally {
    db.close();
  }
}

function sqliteIndexRows(sqlitePath: string, dimensions: number, signature: string | null): Array<{ chunk_id: string; content_hash: string; embedding?: number[] | null; embedding_signature?: string | null; embedding_error?: string | null }> {
  if (!fssync.existsSync(sqlitePath)) return [];
  const db = new DatabaseSync(sqlitePath);
  try {
    const rows = db.prepare("SELECT chunk_id, content_hash, embedding, embedding_signature, embedding_error FROM search_chunks ORDER BY chunk_id").all() as Array<{ chunk_id: string; content_hash: string; embedding?: Buffer | null; embedding_signature?: string | null; embedding_error?: string | null }>;
    return rows.map((row) => {
      const embedding = decodeEmbedding(row.embedding ?? null);
      const valid = embedding && (!dimensions || embedding.length === dimensions) && (!signature || row.embedding_signature === signature);
      return { chunk_id: row.chunk_id, content_hash: row.content_hash, embedding: valid ? embedding : null, embedding_signature: row.embedding_signature ?? null, embedding_error: valid ? row.embedding_error ?? null : row.embedding ? "invalid search embedding blob" : row.embedding_error ?? null };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function encodeEmbedding(values: number[]): Buffer {
  const array = new Float32Array(values);
  return Buffer.from(array.buffer);
}

function decodeEmbedding(value: Buffer | null): number[] | null {
  if (!value) return null;
  if (value.byteLength % 4 !== 0) return null;
  const copy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return [...new Float32Array(copy)];
}

function embeddableText(chunk: SearchChunk): string {
  return [chunk.title, chunk.aliases.join(" "), chunk.tags.join(" "), chunk.heading, chunk.body].filter(Boolean).join("\n");
}

function ensureDirSync(dir: string): void {
  fssync.mkdirSync(dir, { recursive: true });
}
