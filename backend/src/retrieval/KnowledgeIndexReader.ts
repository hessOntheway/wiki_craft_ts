import * as fssync from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig, WorkspacePaths } from "../types.ts";
import { embeddingsEnabled, embeddingSignature } from "../knowledge/embeddings.ts";
import type { SearchChunk, SearchIndexCache } from "../knowledge/model.ts";

export class KnowledgeIndexReader {
  private readonly paths: WorkspacePaths;
  private readonly settings: AppConfig["search"];

  constructor(paths: WorkspacePaths, settings: AppConfig["search"]) {
    this.paths = paths;
    this.settings = settings;
  }

  get sqlitePath(): string {
    return this.paths.searchIndexPath;
  }

  loadChunks(): SearchChunk[] {
    return sqliteIndexedChunks(this.paths.searchIndexPath);
  }

  loadCache(): SearchIndexCache {
    return sqliteIndexCache(this.paths.searchIndexPath, this.settings);
  }
}

function graphEdgeCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM search_graph_edges").get() as { count: number };
  return row.count;
}

function sqliteGraphEdgeCountIfExists(sqlitePath: string): number {
  if (!fssync.existsSync(sqlitePath)) return 0;
  const db = new DatabaseSync(sqlitePath);
  try {
    return graphEdgeCount(db);
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

function sqliteIndexedChunks(sqlitePath: string): SearchChunk[] {
  if (!fssync.existsSync(sqlitePath)) return [];
  const db = new DatabaseSync(sqlitePath);
  try {
    const rows = db.prepare("SELECT * FROM search_chunks ORDER BY chunk_id").all() as Array<{
      chunk_id: string;
      display_path?: string | null;
      relative_path?: string | null;
      kind?: string | null;
      title?: string | null;
      aliases?: string | null;
      tags?: string | null;
      wikilinks?: string | null;
      source_ids?: string | null;
      source_urls?: string | null;
      version_hashes?: string | null;
      updated_at_run_id?: string | null;
      heading?: string | null;
      body?: string | null;
      line_start?: number | null;
    }>;
    return rows.map((row) => {
      const displayPath = row.display_path?.trim() || pathFromChunkId(row.chunk_id);
      return {
        id: row.chunk_id,
        displayPath,
        relativePath: row.relative_path?.trim() || displayPath,
        kind: row.kind === "index" ? "index" : "topic",
        title: row.title || null,
        heading: row.heading || null,
        body: row.body ?? "",
        lineStart: Math.max(1, Number(row.line_start) || 1),
        aliases: splitStoredList(row.aliases),
        tags: splitStoredList(row.tags),
        wikilinks: splitStoredList(row.wikilinks),
        source_ids: parseStoredJsonList(row.source_ids),
        source_urls: parseStoredJsonList(row.source_urls),
        version_hashes: parseStoredJsonList(row.version_hashes),
        updated_at_run_id: row.updated_at_run_id || null,
        graph_edges: [],
      };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function sqliteIndexCache(sqlitePath: string, settings: AppConfig["search"]): SearchIndexCache {
  const signature = embeddingsEnabled(settings) ? embeddingSignature(settings) : null;
  const rows = sqliteIndexRows(sqlitePath, settings.embedding_dimensions, signature);
  return {
    schema_version: 1,
    fingerprint: "",
    chunks: rows.map((row) => ({ id: row.chunk_id, hash: row.content_hash, embedding: row.embedding ?? undefined })),
    embedding_signature: signature,
    embedding_warning: rows.find((row) => row.embedding_error)?.embedding_error ?? null,
    stale_vectors: rows.filter((row) => row.embedding_signature && row.embedding_signature !== signature).length,
    graph_edges: sqliteGraphEdgeCountIfExists(sqlitePath),
  };
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

function decodeEmbedding(value: Buffer | null): number[] | null {
  if (!value) return null;
  if (value.byteLength % 4 !== 0) return null;
  const copy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return [...new Float32Array(copy)];
}

function pathFromChunkId(chunkId: string): string {
  const separator = chunkId.lastIndexOf("#");
  return separator > 0 ? chunkId.slice(0, separator) : chunkId;
}

function splitStoredList(value?: string | null): string[] {
  return (value ?? "").split(/\s+/u).map((item) => item.trim()).filter(Boolean);
}

function parseStoredJsonList(value?: string | null): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return splitStoredList(trimmed);
  }
}
