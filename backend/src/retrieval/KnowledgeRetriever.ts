import type { AppConfig, WorkspacePaths } from "../types.ts";
import type { SearchChunk, SearchResponse, SupportingRelation } from "../knowledge/model.ts";
import { termsFor } from "../knowledge/text.ts";
import { truncateChars } from "../util.ts";
import { GraphRetriever } from "./GraphRetriever.ts";
import { KnowledgeIndexReader } from "./KnowledgeIndexReader.ts";
import { LexicalRetriever } from "./LexicalRetriever.ts";
import { VectorRetriever } from "./VectorRetriever.ts";

export async function retrieveKnowledge(paths: WorkspacePaths, settings: AppConfig["search"], query: string, topK: number): Promise<SearchResponse> {
  return new KnowledgeRetriever(paths, settings).retrieve(query, topK);
}

export class KnowledgeRetriever {
  private readonly reader: KnowledgeIndexReader;
  private readonly lexicalRetriever: LexicalRetriever;
  private readonly vectorRetriever: VectorRetriever;
  private readonly graphRetriever: GraphRetriever;

  constructor(
    paths: WorkspacePaths,
    settings: AppConfig["search"],
    reader = new KnowledgeIndexReader(paths, settings),
    lexicalRetriever = new LexicalRetriever(),
    vectorRetriever = new VectorRetriever(settings),
    graphRetriever = new GraphRetriever(),
  ) {
    this.reader = reader;
    this.lexicalRetriever = lexicalRetriever;
    this.vectorRetriever = vectorRetriever;
    this.graphRetriever = graphRetriever;
  }

  async retrieve(query: string, topK: number): Promise<SearchResponse> {
    const chunks = this.reader.loadChunks();
    const cache = this.reader.loadCache();
    const retrievalLimit = Math.max(20, Math.min(100, Math.round(topK || 5) * 4));
    let retrievalMode: SearchResponse["retrieval_mode"] = "bm25";
    let warning = cache.embedding_warning ?? null;
    const lexicalHits = await this.lexicalRetriever.search(this.reader.sqlitePath, chunks, query, retrievalLimit);
    const vector = this.vectorRetriever.canSearch(cache)
      ? await this.vectorRetriever.search(query, cache).catch((error) => {
        warning = String(error instanceof Error ? error.message : error);
        return [];
      })
      : [];
    const graphHits = this.graphRetriever.wantsTraversal(query)
      ? await this.graphRetriever.search(this.reader.sqlitePath, query, retrievalLimit).catch(() => [])
      : [];
    const scores = new Map<string, number>();
    const breakdown = new Map<string, { lexical?: number; vector?: number; graph?: number }>();
    const relations = new Map<string, SupportingRelation[]>();
    for (const [rank, hit] of lexicalHits.entries()) addScore(scores, breakdown, hit.id, "lexical", 1 / (60 + rank + 1));
    for (const [rank, hit] of vector.entries()) addScore(scores, breakdown, hit.id, "vector", 1 / (60 + rank + 1));
    for (const [rank, hit] of graphHits.entries()) {
      addScore(scores, breakdown, hit.id, "graph", 0.65 / (60 + rank + 1));
      relations.set(hit.id, hit.relations);
    }
    if (vector.length > 0) retrievalMode = "hybrid";
    if (graphHits.length > 0) retrievalMode = "graph_hybrid";
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const hits = [...scores.entries()]
      .map(([id, score]) => ({ chunk: byId.get(id), score }))
      .filter((hit): hit is { chunk: SearchChunk; score: number } => Boolean(hit.chunk))
      .sort((a, b) => b.score - a.score || kindRank(a.chunk.kind) - kindRank(b.chunk.kind) || a.chunk.id.localeCompare(b.chunk.id))
      .slice(0, Math.min(20, Math.max(1, Math.round(topK || 5))));
    return {
      query,
      top_k: Math.min(20, Math.max(1, Math.round(topK || 5))),
      retrieval_mode: retrievalMode,
      index_status: {
        indexed_chunks: chunks.length,
        embedded_chunks: cache.chunks.filter((chunk) => chunk.embedding).length,
        stale_vectors: cache.stale_vectors ?? 0,
        graph_edges: cache.graph_edges ?? 0,
        embedding_signature: cache.embedding_signature ?? null,
        warning,
      },
      results: hits.map(({ chunk, score }) => ({
        path: chunk.displayPath,
        kind: chunk.kind,
        title: chunk.title,
        heading: chunk.heading,
        score,
        line_start: chunk.lineStart,
        line_end: chunk.lineStart + chunk.body.split(/\r?\n/u).length - 1,
        snippet: snippet(chunk.body, query),
        aliases: chunk.aliases,
        tags: chunk.tags,
        wikilinks: chunk.wikilinks,
        source_ids: chunk.source_ids,
        source_urls: chunk.source_urls,
        version_hashes: chunk.version_hashes,
        updated_at_run_id: chunk.updated_at_run_id,
        score_breakdown: breakdown.get(chunk.id),
        supporting_relations: relations.get(chunk.id) ?? [],
      })),
    };
  }
}

function addScore(
  scores: Map<string, number>,
  breakdown: Map<string, { lexical?: number; vector?: number; graph?: number }>,
  id: string,
  key: "lexical" | "vector" | "graph",
  value: number,
): void {
  scores.set(id, (scores.get(id) ?? 0) + value);
  const item = breakdown.get(id) ?? {};
  item[key] = (item[key] ?? 0) + value;
  breakdown.set(id, item);
}

function snippet(body: string, query: string): string {
  const max = 1200;
  const trimmed = body.trim();
  if (trimmed.length <= max) return trimmed;
  const lower = body.toLowerCase();
  const firstTerm = termsFor(query)[0] ?? "";
  const index = firstTerm ? lower.indexOf(firstTerm.toLowerCase()) : -1;
  const windowStart = Math.max(0, index - 240);
  const lineStart = body.lastIndexOf("\n", windowStart);
  const start = lineStart >= 0 ? lineStart + 1 : 0;
  return truncateChars(body.slice(start).trim(), max);
}

function kindRank(kind: SearchChunk["kind"]): number {
  return kind === "index" ? 0 : kind === "topic" ? 1 : 2;
}
