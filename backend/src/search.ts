import { promises as fs } from "node:fs";
import * as fssync from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig, RetrievalMode } from "./types.ts";
import { loadConfigForKnowledgeBase, listKnowledgeBases, workspacePaths } from "./config.ts";
import { extractWikilinks, parseVaultFrontmatter } from "./runtime.ts";
import { ensureDir, listFiles, normalizeWhitespace, pathExists, readJson, relPosix, sha256Hex, truncateChars, writeJson } from "./util.ts";

interface SearchChunk {
  id: string;
  displayPath: string;
  relativePath: string;
  kind: "index" | "topic" | "source_summary";
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
}

interface SearchIndexCache {
  schema_version: number;
  fingerprint: string;
  chunks: Array<{ id: string; hash: string; embedding?: number[] }>;
  embedding_signature?: string | null;
  embedding_warning?: string | null;
  stale_vectors?: number;
  graph_edges?: number;
}

interface GraphEdge {
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

interface SupportingRelation {
  subject: string;
  predicate: string;
  object: string;
  evidence_count: number;
}

interface GraphHit {
  id: string;
  score: number;
  relations: SupportingRelation[];
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
    kind: "index" | "topic" | "source_summary";
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

export async function searchConfigured(configPath: string, knowledgeBaseId: string | undefined, query: string, topK: number, requireExplicitKnowledgeBase = false): Promise<SearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) throw new HttpError(400, "search query must not be empty");
  let kbId = knowledgeBaseId?.trim();
  if (!kbId && requireExplicitKnowledgeBase) throw new HttpError(400, "knowledge_base is required");
  if (!kbId) {
    const list = await listKnowledgeBases(configPath);
    kbId = list.active_id ?? list.knowledge_bases[0]?.id;
  }
  if (!kbId) throw new HttpError(400, "knowledge_base is required");

  const config = await loadConfigForKnowledgeBase(configPath, kbId);
  const paths = workspacePaths(config);
  const chunks = await collectChunks(paths.knowledgeCurrent, paths.sourceSummariesCurrent);
  const cache = await refreshIndex(paths.searchIndexPath, paths.searchCachePath, chunks, config.search, false, false);
  const retrievalLimit = Math.max(20, Math.min(100, Math.round(topK || 5) * 4));
  const lexical = sqliteBm25(paths.searchIndexPath, trimmed, retrievalLimit)
    .then((hits) => hits.length > 0 ? hits : bm25(chunks, trimmed))
    .catch(() => bm25(chunks, trimmed));
  let retrievalMode: RetrievalMode = "bm25";
  let warning = cache.embedding_warning ?? null;
  const lexicalHits = await lexical;
  const vector = embeddingsEnabled(config.search) && cache.chunks.some((chunk) => chunk.embedding)
    ? await vectorHits(trimmed, cache, config.search).catch((error) => {
      warning = String(error instanceof Error ? error.message : error);
      return [];
    })
    : [];
  const graph = sqliteGraphHits(paths.searchIndexPath, trimmed, retrievalLimit).catch(() => []);
  const graphHits = await graph;
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
    query: trimmed,
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
      snippet: snippet(chunk.body, trimmed),
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

export async function reindexConfigured(configPath: string, knowledgeBaseId?: string, lexicalOnly = false): Promise<SearchResponse["index_status"]> {
  const config = await loadConfigForKnowledgeBase(configPath, knowledgeBaseId);
  if (!config.knowledge_base) throw new Error("no active knowledge base; create one in the GUI or run `knowledge-base create`");
  const paths = workspacePaths(config);
  const chunks = await collectChunks(paths.knowledgeCurrent, paths.sourceSummariesCurrent);
  const cache = await refreshIndex(paths.searchIndexPath, paths.searchCachePath, chunks, config.search, lexicalOnly, true);
  return {
    indexed_chunks: chunks.length,
    embedded_chunks: cache.chunks.filter((chunk) => chunk.embedding).length,
    stale_vectors: cache.stale_vectors ?? 0,
    graph_edges: cache.graph_edges ?? 0,
    embedding_signature: cache.embedding_signature ?? null,
    warning: cache.embedding_warning ?? null,
  };
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

async function collectChunks(knowledgeRoot: string, summariesRoot: string): Promise<SearchChunk[]> {
  const docs: SearchChunk[] = [];
  const index = path.join(knowledgeRoot, "index.md");
  if (await pathExists(index)) docs.push(...await readDocument(index, knowledgeRoot, "index"));
  const topics = path.join(knowledgeRoot, "topics");
  for (const file of await listFiles(topics, (candidate) => candidate.endsWith(".md"))) {
    docs.push(...await readDocument(file, knowledgeRoot, "topic"));
  }
  for (const file of await listFiles(summariesRoot, (candidate) => candidate.endsWith(".md"))) {
    docs.push(...await readDocument(file, knowledgeRoot, "source_summary", summariesRoot));
  }
  return docs.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
}

async function readDocument(file: string, knowledgeRoot: string, kind: SearchChunk["kind"], alternateRoot?: string): Promise<SearchChunk[]> {
  const raw = await fs.readFile(file, "utf8");
  const parsed = parseVaultFrontmatter(raw);
  const root = alternateRoot ?? knowledgeRoot;
  const relativePath = relPosix(root, file);
  const displayPath = alternateRoot ? `evidence/source_summaries/${relativePath}` : relativePath;
  const sections = splitSections(parsed.body);
  return sections.map((section, index) => ({
    id: `${displayPath}#${index}`,
    displayPath,
    relativePath,
    kind,
    title: parsed.title ?? null,
    heading: section.heading,
    body: section.text,
    lineStart: parsed.body_start_line + section.lineOffset,
    aliases: parsed.aliases,
    tags: parsed.tags,
    wikilinks: extractWikilinks(section.text),
    source_ids: parsed.source_ids,
    source_urls: parsed.source_urls,
    version_hashes: parsed.version_hashes,
    updated_at_run_id: parsed.updated_at_run_id ?? null,
  }));
}

function splitSections(body: string): Array<{ heading?: string | null; text: string; lineOffset: number }> {
  const lines = body.split(/\r?\n/u);
  const sections: Array<{ heading?: string | null; lines: string[]; lineOffset: number }> = [];
  let current = { heading: null as string | null, lines: [] as string[], lineOffset: 0 };
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^(#{1,6})\s+(.+)$/u);
    if (match && current.lines.some((value) => value.trim())) {
      sections.push(current);
      current = { heading: match[2].trim(), lines: [line], lineOffset: index };
    } else {
      if (match && !current.heading) current.heading = match[2].trim();
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections.filter((section) => section.lines.join("\n").trim()).map((section) => ({
    heading: section.heading,
    text: section.lines.join("\n"),
    lineOffset: section.lineOffset,
  }));
}

function bm25(chunks: SearchChunk[], query: string): Array<{ id: string; score: number }> {
  const terms = termsFor(query);
  const docs = chunks.map((chunk) => ({
    id: chunk.id,
    terms: termsFor(`${chunk.title ?? ""} ${chunk.heading ?? ""} ${chunk.tags.join(" ")} ${chunk.body}`),
  }));
  const avgLen = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const term of new Set(docs.flatMap((doc) => [...new Set(doc.terms)]))) {
    df.set(term, docs.filter((doc) => doc.terms.includes(term)).length);
  }
  return docs.map((doc) => {
    let score = 0;
    for (const term of terms) {
      const freq = doc.terms.filter((value) => value === term).length;
      if (!freq) continue;
      const idf = Math.log(1 + (docs.length - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += idf * ((freq * 2.2) / (freq + 1.2 * (0.25 + 0.75 * (doc.terms.length / Math.max(avgLen, 1)))));
    }
    return { id: doc.id, score };
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score);
}

async function refreshIndex(
  sqlitePath: string,
  cachePath: string,
  chunks: SearchChunk[],
  settings: AppConfig["search"],
  lexicalOnly: boolean,
  force: boolean,
): Promise<SearchIndexCache> {
  const fingerprint = sha256Hex(JSON.stringify(chunks.map((chunk) => [chunk.id, sha256Hex(chunk.body)])));
  syncSqliteIndex(sqlitePath, chunks, fingerprint, force);
  const enabled = embeddingsEnabled(settings);
  const signature = enabled ? embeddingSignature(settings) : null;
  if (lexicalOnly || !enabled) clearSqliteEmbeddings(sqlitePath);
  let warning: string | null = null;
  if (enabled && !lexicalOnly) {
    for (const chunk of chunks) {
      const state = sqliteEmbeddingState(sqlitePath, chunk.id);
      if (state.embedding && state.embedding_signature === signature) continue;
      try {
        persistSqliteEmbedding(sqlitePath, chunk.id, await embed(embeddableText(chunk), settings), signature!);
      } catch (error) {
        warning = `embedding unavailable; using BM25 fallback: ${error instanceof Error ? error.message : String(error)}`;
        persistSqliteEmbeddingError(sqlitePath, chunk.id, warning, signature);
        break;
      }
    }
  }
  const rows = sqliteIndexRows(sqlitePath, settings.embedding_dimensions, signature);
  const cache: SearchIndexCache = {
    schema_version: 1,
    fingerprint,
    chunks: rows.map((row) => ({ id: row.chunk_id, hash: row.content_hash, embedding: row.embedding ?? undefined })),
    embedding_signature: signature,
    embedding_warning: warning ?? rows.find((row) => row.embedding_error)?.embedding_error ?? null,
    stale_vectors: rows.filter((row) => row.embedding_signature && row.embedding_signature !== signature).length,
    graph_edges: sqliteGraphEdgeCount(sqlitePath),
  };
  await ensureDir(path.dirname(cachePath));
  await writeJson(cachePath, cache);
  return cache;
}

function syncSqliteIndex(sqlitePath: string, chunks: SearchChunk[], fingerprint: string, force: boolean): void {
  ensureDirSync(path.dirname(sqlitePath));
  const db = new DatabaseSync(sqlitePath);
  try {
    ensureSearchSchema(db);
    const current = db.prepare("SELECT value FROM search_meta WHERE key = 'vault_fingerprint'").get() as { value?: string } | undefined;
    if (!force && current?.value === fingerprint && (chunks.length === 0 || graphEdgeCount(db) > 0)) return;
    db.exec("CREATE TEMP TABLE IF NOT EXISTS active_search_chunks (chunk_id TEXT PRIMARY KEY); DELETE FROM active_search_chunks;");
    const active = db.prepare("INSERT INTO active_search_chunks (chunk_id) VALUES (?)");
    const upsert = db.prepare(`INSERT INTO search_chunks (
      chunk_id, content_hash, title, aliases, tags, wikilinks, heading, body, embeddable_text,
      embedding, embedding_signature, embedding_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    ON CONFLICT(chunk_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      title = excluded.title,
      aliases = excluded.aliases,
      tags = excluded.tags,
      wikilinks = excluded.wikilinks,
      heading = excluded.heading,
      body = excluded.body,
      embeddable_text = excluded.embeddable_text,
      embedding = CASE WHEN search_chunks.content_hash = excluded.content_hash THEN search_chunks.embedding ELSE NULL END,
      embedding_signature = CASE WHEN search_chunks.content_hash = excluded.content_hash THEN search_chunks.embedding_signature ELSE NULL END,
      embedding_error = CASE WHEN search_chunks.content_hash = excluded.content_hash THEN search_chunks.embedding_error ELSE NULL END`);
    for (const chunk of chunks) {
      const title = chunk.title ?? "";
      const aliases = chunk.aliases.join(" ");
      const tags = chunk.tags.join(" ");
      const wikilinks = chunk.wikilinks.join(" ");
      const heading = chunk.heading ?? "";
      const embeddable = embeddableText(chunk);
      active.run(chunk.id);
      upsert.run(chunk.id, sha256Hex(chunk.body), title, aliases, tags, wikilinks, heading, chunk.body, embeddable);
    }
    db.exec("DELETE FROM search_chunks WHERE chunk_id NOT IN (SELECT chunk_id FROM active_search_chunks);");
    rebuildGraphIndex(db, chunks);
    rebuildFtsIndex(db);
    db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('schema_version', '1')").run();
    db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('vault_fingerprint', ?)").run(fingerprint);
  } finally {
    db.close();
  }
}

function ensureSearchSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS search_chunks (
  chunk_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  aliases TEXT NOT NULL,
  tags TEXT NOT NULL,
  wikilinks TEXT NOT NULL,
  heading TEXT NOT NULL,
  body TEXT NOT NULL,
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
  }
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
  const subject = graphSubjectForChunk(chunk);
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
  push(chunk.displayPath, "has_kind", chunk.kind);
  if (chunk.title) push(chunk.displayPath, "has_title", chunk.title);
  if (chunk.heading) push(subject, "has_heading", chunk.heading);
  for (const alias of chunk.aliases) push(alias, "alias_of", subject);
  for (const tag of chunk.tags) push(subject, "has_tag", tag);
  for (const link of chunk.wikilinks) push(subject, "links_to", link);
  for (const sourceId of chunk.source_ids) push(subject, "has_source", sourceId);
  for (const [index, sourceUrl] of chunk.source_urls.entries()) push(chunk.source_ids[index] ?? subject, "source_url", sourceUrl);
  for (const [index, versionHash] of chunk.version_hashes.entries()) push(chunk.source_ids[index] ?? subject, "has_version", versionHash);
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.chunk_id}\0${edge.subject}\0${edge.predicate}\0${edge.object}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function graphSubjectForChunk(chunk: SearchChunk): string {
  return chunk.title || chunk.heading || chunk.displayPath;
}

function graphEdgeId(edge: GraphEdge): string {
  return sha256Hex(`${edge.chunk_id}\0${edge.subject}\0${edge.predicate}\0${edge.object}`);
}

async function sqliteGraphHits(sqlitePath: string, query: string, limit: number): Promise<GraphHit[]> {
  const terms = [...new Set(termsFor(query).map(normalizeGraphText).filter(Boolean))].slice(0, 20);
  if (terms.length === 0) return [];
  const db = new DatabaseSync(sqlitePath);
  try {
    ensureSearchSchema(db);
    const rows = db.prepare(`SELECT chunk_id, subject, predicate, object, subject_norm, predicate_norm, object_norm, evidence_count
      FROM search_graph_edges
      ORDER BY chunk_id, predicate, subject, object
      LIMIT 2500`).all() as Array<{
        chunk_id: string;
        subject: string;
        predicate: string;
        object: string;
        subject_norm: string;
        predicate_norm: string;
        object_norm: string;
        evidence_count: number;
      }>;
    const byChunk = new Map<string, { score: number; relations: SupportingRelation[] }>();
    for (const row of rows) {
      const matched = graphMatchScore(row, terms);
      if (matched <= 0) continue;
      const evidence = Math.max(1, Number(row.evidence_count) || 1);
      const contribution = matched * (1 + Math.log(evidence));
      const current = byChunk.get(row.chunk_id) ?? { score: 0, relations: [] };
      current.score += contribution;
      current.relations.push({ subject: row.subject, predicate: row.predicate, object: row.object, evidence_count: evidence });
      byChunk.set(row.chunk_id, current);
    }
    const max = Math.max(1, ...[...byChunk.values()].map((hit) => hit.score));
    return [...byChunk.entries()]
      .map(([id, hit]) => ({
        id,
        score: hit.score / max,
        relations: topRelations(hit.relations),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  } finally {
    db.close();
  }
}

function graphMatchScore(row: { subject_norm: string; predicate_norm: string; object_norm: string }, queryTerms: string[]): number {
  let score = 0;
  for (const term of queryTerms) {
    if (row.subject_norm.includes(term)) score += 0.9;
    if (row.object_norm.includes(term)) score += 1;
    if (row.predicate_norm.includes(term)) score += 0.45;
  }
  return score / Math.max(1, queryTerms.length);
}

function topRelations(relations: SupportingRelation[]): SupportingRelation[] {
  const unique = new Map<string, SupportingRelation>();
  for (const relation of relations) {
    const key = `${relation.subject}\0${relation.predicate}\0${relation.object}`;
    const existing = unique.get(key);
    if (!existing || relation.evidence_count > existing.evidence_count) unique.set(key, relation);
  }
  return [...unique.values()]
    .sort((a, b) => b.evidence_count - a.evidence_count || a.predicate.localeCompare(b.predicate) || a.subject.localeCompare(b.subject))
    .slice(0, 3);
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
    db.exec("DROP TABLE IF EXISTS search_chunks_fts;");
    db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('fts5_available', 'false')").run();
    db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('fts5_error', ?)").run(error instanceof Error ? error.message : String(error));
  }
}

async function vectorHits(query: string, cache: SearchIndexCache, settings: AppConfig["search"]): Promise<Array<{ id: string; score: number }>> {
  const queryEmbedding = await embed(query, settings);
  return cache.chunks.filter((chunk) => chunk.embedding).map((chunk) => ({
    id: chunk.id,
    score: cosine(queryEmbedding, chunk.embedding!),
  })).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score);
}

async function sqliteBm25(sqlitePath: string, query: string, limit: number): Promise<Array<{ id: string; score: number }>> {
  const expression = ftsExpression(query);
  if (!expression) return [];
  const db = new DatabaseSync(sqlitePath);
  try {
    const rows = db.prepare(`SELECT sc.chunk_id AS id, -bm25(search_chunks_fts, 10.0, 8.0, 6.0, 4.0, 7.0, 1.0) AS score
      FROM search_chunks_fts
      JOIN search_chunks AS sc ON sc.rowid = search_chunks_fts.rowid
      WHERE search_chunks_fts MATCH ?
      ORDER BY bm25(search_chunks_fts, 10.0, 8.0, 6.0, 4.0, 7.0, 1.0), sc.chunk_id
      LIMIT ?`).all(expression, limit) as Array<{ id: string; score: number }>;
    return rows.map((row) => ({ id: row.id, score: row.score }));
  } finally {
    db.close();
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
  const db = new DatabaseSync(sqlitePath);
  try {
    const rows = db.prepare("SELECT chunk_id, content_hash, embedding, embedding_signature, embedding_error FROM search_chunks ORDER BY chunk_id").all() as Array<{ chunk_id: string; content_hash: string; embedding?: Buffer | null; embedding_signature?: string | null; embedding_error?: string | null }>;
    return rows.map((row) => {
      const embedding = decodeEmbedding(row.embedding ?? null);
      const valid = embedding && (!dimensions || embedding.length === dimensions) && (!signature || row.embedding_signature === signature);
      return { chunk_id: row.chunk_id, content_hash: row.content_hash, embedding: valid ? embedding : null, embedding_signature: row.embedding_signature ?? null, embedding_error: valid ? row.embedding_error ?? null : row.embedding ? "invalid search embedding blob" : row.embedding_error ?? null };
    });
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

function ftsExpression(query: string): string {
  return [...new Set(termsFor(query))]
    .filter((term) => /^[\p{Letter}\p{Number}_-]+$/u.test(term))
    .slice(0, 20)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function embeddableText(chunk: SearchChunk): string {
  return [chunk.title, chunk.aliases.join(" "), chunk.tags.join(" "), chunk.heading, chunk.body].filter(Boolean).join("\n");
}

function embeddingsEnabled(settings: AppConfig["search"]): boolean {
  return settings.embedding_provider !== "none";
}

function embeddingSignature(settings: AppConfig["search"]): string {
  return `${settings.embedding_provider}:${settings.embedding_model}:${settings.embedding_dimensions}`;
}

async function embed(text: string, settings: AppConfig["search"]): Promise<number[]> {
  if (settings.embedding_provider === "ollama") return embedWithOllama(text, settings);
  if (settings.embedding_provider === "openai_compatible") return embedWithOpenAiCompatible(text, settings);
  throw new Error("embedding provider is disabled");
}

async function embedWithOllama(text: string, settings: AppConfig["search"]): Promise<number[]> {
  const response = await fetch(`${settings.ollama_endpoint.replace(/\/+$/u, "")}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.embedding_model, input: text }),
    signal: AbortSignal.timeout(settings.embedding_timeout_seconds * 1000),
  });
  if (!response.ok) throw new Error(`embedding api error (${response.status})`);
  const payload = await response.json() as { embeddings?: number[][] };
  const embedding = payload.embeddings?.[0];
  if (!embedding) throw new Error("embedding api returned no embedding");
  return embedding;
}

async function embedWithOpenAiCompatible(text: string, settings: AppConfig["search"]): Promise<number[]> {
  const endpoint = settings.embedding_endpoint.trim();
  if (!endpoint) throw new Error("embedding_endpoint is required for openai_compatible embeddings");
  const base = endpoint.replace(/\/+$/u, "");
  const url = base.endsWith("/embeddings") ? base : `${base}/embeddings`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.embedding_api_key?.trim()) headers.Authorization = `Bearer ${settings.embedding_api_key.trim()}`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: settings.embedding_model, input: text }),
    signal: AbortSignal.timeout(settings.embedding_timeout_seconds * 1000),
  });
  if (!response.ok) throw new Error(`embedding api error (${response.status})`);
  const payload = await response.json() as { data?: Array<{ embedding?: number[] }>; embeddings?: number[][] };
  const embedding = payload.data?.[0]?.embedding ?? payload.embeddings?.[0];
  if (!embedding) throw new Error("embedding api returned no embedding");
  return embedding;
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] ** 2;
    rightNorm += right[i] ** 2;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1);
}

function termsFor(text: string): string[] {
  const normalized = normalizeWhitespace(text.toLowerCase());
  const words = normalized.match(/[\p{Letter}\p{Number}]+/gu) ?? [];
  const segmented = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("zh", { granularity: "word" }).segment(normalized)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment)
    : [];
  const cjk = [...normalized].filter((ch) => /\p{Script=Han}/u.test(ch));
  const cjkBigrams = [];
  for (let i = 0; i < cjk.length - 1; i += 1) cjkBigrams.push(`${cjk[i]}${cjk[i + 1]}`);
  return [...words, ...segmented, ...cjk, ...cjkBigrams].filter((term) => term.length > 0);
}

function normalizeGraphText(text: string): string {
  return [...new Set(termsFor(text))].join(" ");
}

function snippet(body: string, query: string): string {
  const lower = body.toLowerCase();
  const firstTerm = termsFor(query)[0] ?? "";
  const index = firstTerm ? lower.indexOf(firstTerm.toLowerCase()) : -1;
  const start = Math.max(0, index - 240);
  return truncateChars(body.slice(start).trim(), 1200);
}

function kindRank(kind: SearchChunk["kind"]): number {
  return kind === "index" ? 0 : kind === "topic" ? 1 : 2;
}

function ensureDirSync(dir: string): void {
  fssync.mkdirSync(dir, { recursive: true });
}
