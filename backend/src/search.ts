import path from "node:path";
import type { RetrievalMode } from "./types.ts";
import { loadConfigForKnowledgeBase, listKnowledgeBases, workspacePaths } from "./config.ts";
import { buildKnowledgeIndex } from "./indexing/index.ts";
import type { SearchResponse, SupportingRelation } from "./knowledge/model.ts";
export type { SearchResponse } from "./knowledge/model.ts";
import { retrieveKnowledge } from "./retrieval/index.ts";
import { nowMs, readJson, sha256Hex, writeJson } from "./util.ts";

interface SearchQueryLogEntry {
  ts_unix_ms: number;
  ts_iso: string;
  query: string;
  top_k: number;
  retrieval_mode: RetrievalMode;
  result_count: number;
  index_status: SearchQueryLogIndexStatus;
  results: SearchQueryLogResult[];
}

interface SearchQueryLogIndexStatus {
  indexed_chunks: number;
  embedded_chunks?: number;
  stale_vectors?: number;
  graph_edges?: number;
  embedding_signature?: string;
  warning?: string;
}

interface SearchQueryLogResult {
  rank: number;
  path: string;
  kind: "index" | "topic";
  title?: string;
  heading?: string;
  score: number;
  line_start: number;
  line_end: number;
  snippet: string;
  score_breakdown?: {
    lexical?: number;
    vector?: number;
    graph?: number;
  };
  source_urls?: string[];
  supporting_relations?: SupportingRelation[];
}

interface SearchQuerySessionLog {
  schema_version: 1;
  session_id: string | null;
  session_missing: boolean;
  knowledge_base: {
    id?: string | null;
    name?: string | null;
  };
  latest_log_at_unix_ms: number;
  latest_log_at_iso: string;
  entries: SearchQueryLogEntry[];
}
export async function searchConfigured(configPath: string, knowledgeBaseId: string | undefined, query: string, topK: number, sessionId?: string, requireExplicitKnowledgeBase = false): Promise<SearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) throw new HttpError(400, "search query must not be empty");
  const trimmedSessionId = sessionId?.trim() || null;
  let kbId = knowledgeBaseId?.trim();
  if (!kbId && requireExplicitKnowledgeBase) throw new HttpError(400, "knowledge_base is required");
  if (!kbId) {
    const list = await listKnowledgeBases(configPath);
    kbId = list.active_id ?? list.knowledge_bases[0]?.id;
  }
  if (!kbId) throw new HttpError(400, "knowledge_base is required");

  const config = await loadConfigForKnowledgeBase(configPath, kbId);
  const paths = workspacePaths(config);
  const response = await retrieveKnowledge(paths, config.search, trimmed, topK);
  const loggedAtMs = nowMs();
  const entry: SearchQueryLogEntry = {
    ts_unix_ms: loggedAtMs,
    ts_iso: new Date(loggedAtMs).toISOString(),
    query: trimmed,
    top_k: response.top_k,
    retrieval_mode: response.retrieval_mode,
    result_count: response.results.length,
    index_status: compactIndexStatusForLog(response.index_status),
    results: compactSearchResultsForLog(response.results),
  };
  await appendSearchQueryLog(paths.searchQuerySessionsDir, {
    sessionId: trimmedSessionId,
    knowledgeBase: {
      id: config.knowledge_base?.id ?? kbId,
      name: config.knowledge_base?.name ?? null,
    },
    entry,
  });
  return response;
}

function compactIndexStatusForLog(status: SearchResponse["index_status"]): SearchQueryLogIndexStatus {
  return {
    indexed_chunks: status.indexed_chunks,
    ...(status.embedded_chunks > 0 ? { embedded_chunks: status.embedded_chunks } : {}),
    ...(status.stale_vectors > 0 ? { stale_vectors: status.stale_vectors } : {}),
    ...(status.graph_edges > 0 ? { graph_edges: status.graph_edges } : {}),
    ...(status.embedding_signature ? { embedding_signature: status.embedding_signature } : {}),
    ...(status.warning ? { warning: status.warning } : {}),
  };
}

function compactSearchResultsForLog(results: SearchResponse["results"]): SearchQueryLogResult[] {
  return results.map((result, index) => ({
    rank: index + 1,
    path: result.path,
    kind: result.kind,
    ...(result.title ? { title: result.title } : {}),
    ...(result.heading ? { heading: result.heading } : {}),
    score: result.score,
    line_start: result.line_start,
    line_end: result.line_end,
    snippet: result.snippet,
    ...(result.score_breakdown ? { score_breakdown: result.score_breakdown } : {}),
    ...(result.source_urls.length > 0 ? { source_urls: result.source_urls } : {}),
    ...(result.supporting_relations?.length ? { supporting_relations: result.supporting_relations } : {}),
  }));
}

async function appendSearchQueryLog(dir: string, input: { sessionId: string | null; knowledgeBase: SearchQuerySessionLog["knowledge_base"]; entry: SearchQueryLogEntry }): Promise<void> {
  try {
    const file = searchQuerySessionFile(dir, input.sessionId);
    const existing = await readJson<SearchQuerySessionLog | null>(file, null);
    await writeJson(file, {
      schema_version: 1,
      session_id: input.sessionId,
      session_missing: !input.sessionId,
      knowledge_base: input.knowledgeBase,
      latest_log_at_unix_ms: input.entry.ts_unix_ms,
      latest_log_at_iso: input.entry.ts_iso,
      entries: [...(existing?.entries ?? []), input.entry],
    });
  } catch {
    // Search should remain available even when the local query log cannot be written.
  }
}

function searchQuerySessionFile(dir: string, sessionId: string | null): string {
  if (!sessionId) return path.join(dir, "missing-session.json");
  const slug = sessionId.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "session";
  return path.join(dir, `${slug}-${sha256Hex(sessionId).slice(0, 12)}.json`);
}

export async function reindexConfigured(configPath: string, knowledgeBaseId?: string, lexicalOnly = false): Promise<SearchResponse["index_status"]> {
  const config = await loadConfigForKnowledgeBase(configPath, knowledgeBaseId);
  if (!config.knowledge_base) throw new Error("no active knowledge base; create one in the GUI or run `knowledge-base create`");
  const paths = workspacePaths(config);
  return buildKnowledgeIndex(paths, config.search, lexicalOnly);
}

export function renderTextResponse(response: SearchResponse): string {
  if (response.results.length === 0) return `No Wiki Craft results for \`${response.query}\`.`;
  const lines = [`Wiki Craft ${response.retrieval_mode} results for \`${response.query}\`:`];
  if (response.index_status.warning) lines.push(`warning: ${response.index_status.warning}`);
  response.results.forEach((result, index) => {
    const heading = result.heading ? ` - ${result.heading}` : "";
    const title = result.title ? ` (${result.title})` : "";
    lines.push(`${index + 1}. ${result.path}:${result.line_start}${title}${heading} [${result.kind}, score ${result.score.toFixed(2)}]`);
    const parts = [
      result.score_breakdown?.lexical ? `bm25 ${result.score_breakdown.lexical.toFixed(4)}` : null,
      result.score_breakdown?.vector ? `vector ${result.score_breakdown.vector.toFixed(4)}` : null,
      result.score_breakdown?.graph ? `graph ${result.score_breakdown.graph.toFixed(4)}` : null,
    ].filter(Boolean);
    if (parts.length > 0) lines.push(`   score: ${parts.join(", ")}`);
    if (result.supporting_relations?.length) {
      lines.push(`   related: ${result.supporting_relations.map((relation) => `${relation.subject} -> ${relation.predicate} -> ${relation.object}`).join("; ")}`);
    }
    if (result.source_urls.length > 0) lines.push(`   sources: ${result.source_urls.join(", ")}`);
    lines.push(result.snippet.split(/\r?\n/u).map((line) => `   ${line}`).join("\n"));
  });
  return lines.join("\n");
}

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
