import type { RetrievalMode } from "../types.ts";

export interface ChunkGraphEdge {
  subject: string;
  predicate: string;
  object: string;
}

export interface SearchChunk {
  id: string;
  displayPath: string;
  relativePath: string;
  kind: "index" | "topic";
  title?: string | null;
  heading?: string | null;
  body: string;
  lineStart: number;
  aliases: string[];
  tags: string[];
  wikilinks: string[];
  source_ids: string[];
  source_urls: string[];
  version_hashes: string[];
  updated_at_run_id?: string | null;
  graph_edges: ChunkGraphEdge[];
}

export interface SearchIndexCache {
  schema_version: number;
  fingerprint: string;
  chunks: Array<{ id: string; hash: string; embedding?: number[] }>;
  embedding_signature?: string | null;
  embedding_warning?: string | null;
  stale_vectors?: number;
  graph_edges?: number;
}

export interface GraphEdge {
  chunk_id: string;
  document_id: string;
  subject: string;
  predicate: string;
  object: string;
  evidence_count: number;
  content_hash: string;
  attrs_json: string;
  updated_at: string;
}

export interface SupportingRelation {
  subject: string;
  predicate: string;
  object: string;
  evidence_count: number;
}

export interface GraphHit {
  id: string;
  score: number;
  relations: SupportingRelation[];
}

export type SearchIndexAction = "add" | "update" | "delete";
export type SearchImportMode = "full" | "incremental";

export interface SearchIndexEvent {
  schema_version: 1;
  event_id: string;
  run_id: string;
  import_mode: SearchImportMode;
  ts_unix_ms: number;
  action: SearchIndexAction;
  chunk_id: string;
  page_path: string;
  heading?: string | null;
  old_content_hash?: string | null;
  new_content_hash?: string | null;
  unit_hash?: string | null;
  source_refs: string[];
  index_ops: {
    keyword: SearchIndexAction[];
    vector: SearchIndexAction[];
    graph: SearchIndexAction[];
  };
}

export interface SearchIndexErrorEvent {
  schema_version: 1;
  run_id: string;
  event_id?: string;
  ts_unix_ms: number;
  stage: "keyword" | "vector" | "graph" | "event_log" | "cache";
  chunk_id?: string;
  action?: SearchIndexAction;
  error: string;
}

export interface GraphQueryPlan {
  predicate: "uses_l3_method";
  knownSide: "subject" | "object";
  knownText: string;
  knownTerms: string[];
}

export interface SearchResponse {
  query: string;
  top_k: number;
  retrieval_mode: RetrievalMode;
  index_status: {
    indexed_chunks: number;
    embedded_chunks: number;
    stale_vectors: number;
    graph_edges: number;
    embedding_signature?: string | null;
    warning?: string | null;
  };
  results: Array<{
    path: string;
    kind: "index" | "topic";
    title?: string | null;
    heading?: string | null;
    score: number;
    line_start: number;
    line_end: number;
    snippet: string;
    aliases: string[];
    tags: string[];
    wikilinks: string[];
    source_ids: string[];
    source_urls: string[];
    version_hashes: string[];
    updated_at_run_id?: string | null;
    score_breakdown?: {
      lexical?: number;
      vector?: number;
      graph?: number;
    };
    supporting_relations?: SupportingRelation[];
  }>;
}
