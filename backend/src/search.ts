import { promises as fs } from "node:fs";
import * as fssync from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig, RetrievalMode, WorkspacePaths } from "./types.ts";
import { loadConfigForKnowledgeBase, listKnowledgeBases, workspacePaths } from "./config.ts";
import { extractWikilinks, parseVaultFrontmatter } from "./runtime.ts";
import { appendJsonl, ensureDir, listFiles, normalizeWhitespace, nowMs, pathExists, readJson, relPosix, sha256Hex, truncateChars, writeJson } from "./util.ts";

interface ChunkGraphEdge {
  subject: string;
  predicate: string;
  object: string;
}

interface SearchChunk {
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

type SearchIndexAction = "add" | "update" | "delete";
type SearchImportMode = "full" | "incremental";

interface SearchIndexEvent {
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

interface SearchIndexErrorEvent {
  schema_version: 1;
  run_id: string;
  event_id?: string;
  ts_unix_ms: number;
  stage: "keyword" | "vector" | "graph" | "event_log" | "cache";
  chunk_id?: string;
  action?: SearchIndexAction;
  error: string;
}

interface GraphQueryPlan {
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
  const chunks = sqliteIndexedChunks(paths.searchIndexPath);
  const cache = sqliteIndexCache(paths.searchIndexPath, config.search);
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
  const graphHits = wantsGraphTraversal(trimmed)
    ? await sqliteGraphHits(paths.searchIndexPath, trimmed, retrievalLimit).catch(() => [])
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
  const response: SearchResponse = {
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
  const chunks = await collectChunks(paths.knowledgeCurrent);
  const cache = await refreshIndex(paths, chunks, config.search, lexicalOnly, true);
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

async function collectChunks(knowledgeRoot: string): Promise<SearchChunk[]> {
  const docs: SearchChunk[] = [];
  for (const file of await listFiles(knowledgeRoot, (candidate) => candidate.endsWith(".md"))) {
    const relative = relPosix(knowledgeRoot, file);
    docs.push(...await readDocument(file, knowledgeRoot, relative === "index.md" ? "index" : "topic"));
  }
  return docs.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
}

async function readDocument(file: string, knowledgeRoot: string, kind: SearchChunk["kind"]): Promise<SearchChunk[]> {
  const raw = await fs.readFile(file, "utf8");
  const parsed = parseVaultFrontmatter(raw);
  const relativePath = relPosix(knowledgeRoot, file);
  if (codeModelFileExcludedFromSearch(relativePath)) return [];
  const displayPath = relativePath;
  const title = parsed.title ?? h1Title(parsed.body);
  const sections = codeModelLayerFile(relativePath)
    ? codeModelSections(relativePath, parsed.body)
    : splitSections(parsed.body);
  return sections.map((section, index) => ({
    id: `${displayPath}#${index}`,
    displayPath,
    relativePath,
    kind,
    title: title ?? null,
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
    graph_edges: section.graphEdges ?? [],
  }));
}

function splitSections(body: string): Array<{ heading?: string | null; text: string; lineOffset: number; graphEdges?: ChunkGraphEdge[] }> {
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

function codeModelSections(relativePath: string, body: string): Array<{ heading?: string | null; text: string; lineOffset: number; graphEdges?: ChunkGraphEdge[] }> {
  const basename = path.posix.basename(relativePath);
  if (basename.startsWith("l1-")) return l1CodeModelSections(body);
  if (basename.startsWith("l2-")) return l2CodeModelSections(body);
  if (basename.startsWith("l3-")) return l3CodeModelSections(body);
  return [];
}

function codeModelFileExcludedFromSearch(relativePath: string): boolean {
  return path.posix.basename(relativePath) === "modeling-guide.md";
}

function codeModelLayerFile(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  return basename.startsWith("l1-") || basename.startsWith("l2-") || basename.startsWith("l3-");
}

function h1Title(body: string): string | undefined {
  return body.split(/\r?\n/u).find((line) => /^#\s+\S/u.test(line))?.replace(/^#\s+/u, "").trim();
}

function l1CodeModelSections(body: string): Array<{ heading?: string | null; text: string; lineOffset: number; graphEdges?: ChunkGraphEdge[] }> {
  const capabilityBlocks = subsectionBlocks(body, "Capabilities", 3);
  return capabilityBlocks.filter((block) => hasRequiredFields(block.text, [
    "Business goal",
    "Business context",
    "Business domains",
    "Expected outcome",
    "Drill down to L2",
  ])).map((block) => ({
    heading: block.heading,
    text: block.text,
    lineOffset: block.lineOffset,
    graphEdges: drillDownEdges(block.heading, block.text),
  }));
}

function l2CodeModelSections(body: string): Array<{ heading?: string | null; text: string; lineOffset: number; graphEdges?: ChunkGraphEdge[] }> {
  const familyHeadings = ["Endpoints", "Commands", "gRPC Methods", "Kafka Consumers"];
  const blocks = familyHeadings.flatMap((family) => subsectionBlocks(body, family, 3).map((block) => ({ ...block, family })));
  return blocks.filter((block) => hasRequiredFields(block.text, [
    "Business goal",
    "Business rules",
    "Business constraints",
    "Expected outcome",
    "Entry parameters",
    "Calls L3",
  ])).sort((left, right) => left.lineOffset - right.lineOffset).map((block) => ({
    heading: `${block.family} > ${block.heading}`,
    text: block.text,
    lineOffset: block.lineOffset,
    graphEdges: callsL3Edges(block.heading, block.text),
  }));
}

function l3CodeModelSections(body: string): Array<{ heading?: string | null; text: string; lineOffset: number; graphEdges?: ChunkGraphEdge[] }> {
  const blocks = subsectionBlocks(body, "Exported API", 3);
  return blocks.filter((block) => hasRequiredFields(block.text, [
    "Business responsibility",
    "Business rules",
    "Business constraints",
    "Expected outcome",
    "Parameters",
    "Returns",
  ])).map((block) => ({
    heading: `Exported API > ${block.heading}`,
    text: block.text,
    lineOffset: block.lineOffset,
    graphEdges: [],
  }));
}

function hasRequiredFields(text: string, fields: string[]): boolean {
  return fields.every((field) => text.split(/\r?\n/u).some((line) => line.trim().startsWith(`- ${field}:`)));
}

function subsectionBlocks(body: string, parentHeading: string, childLevel: number): Array<{ heading: string; text: string; lineOffset: number }> {
  const lines = body.split(/\r?\n/u);
  const parentLevel = Math.max(1, childLevel - 1);
  const parentPattern = new RegExp(`^#{${parentLevel}}\\s+${escapeRegExp(parentHeading)}\\s*$`, "u");
  const childPattern = new RegExp(`^#{${childLevel}}\\s+(.+)$`, "u");
  const boundaryPattern = new RegExp(`^#{1,${childLevel}}\\s+`, "u");
  const parentIndex = lines.findIndex((line) => parentPattern.test(line.trim()));
  if (parentIndex < 0) return [];
  const blocks: Array<{ heading: string; text: string; lineOffset: number }> = [];
  let index = parentIndex + 1;
  while (index < lines.length && !new RegExp(`^#{1,${parentLevel}}\\s+`, "u").test(lines[index])) {
    const match = lines[index].match(childPattern);
    if (!match) {
      index += 1;
      continue;
    }
    const start = index;
    const heading = cleanHeadingText(match[1]);
    index += 1;
    while (index < lines.length && !boundaryPattern.test(lines[index])) index += 1;
    blocks.push({ heading, text: lines.slice(start, index).join("\n"), lineOffset: start });
  }
  return blocks;
}

function drillDownEdges(capability: string, text: string): ChunkGraphEdge[] {
  return listItemsUnderField(text, "Drill down to L2")
    .flatMap((item) => markdownLinkTargets(item))
    .map((target) => ({ subject: capability, predicate: "drills_down_to_l2", object: target }));
}

function callsL3Edges(interfaceName: string, text: string): ChunkGraphEdge[] {
  return listItemsUnderField(text, "Calls L3")
    .filter((item) => item !== "None directly; spawns `backend/src/server.ts` with the current Node executable.")
    .map(stripMarkdownCode)
    .filter(Boolean)
    .map((target) => ({ subject: interfaceName, predicate: "uses_l3_method", object: target }));
}

function listItemsUnderField(text: string, field: string): string[] {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `- ${field}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^-\s+\S/u.test(line)) break;
    const match = line.match(/^\s{2,}-\s+(.+)$/u);
    if (match) out.push(match[1].trim());
  }
  return out;
}

function markdownLinkTargets(text: string): string[] {
  const matches = [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)];
  if (matches.length === 0) return [stripMarkdownCode(text)];
  return matches.map((match) => `${match[1].trim()} (${match[2].trim()})`);
}

function stripMarkdownCode(text: string): string {
  return text.trim().replace(/^`|`$/gu, "");
}

function cleanHeadingText(text: string): string {
  return stripMarkdownCode(text.replace(/\s+#+\s*$/u, ""));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
  paths: WorkspacePaths,
  chunks: SearchChunk[],
  settings: AppConfig["search"],
  lexicalOnly: boolean,
  force: boolean,
): Promise<SearchIndexCache> {
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
        persistSqliteEmbedding(paths.searchIndexPath, chunk.id, await embed(embeddableText(chunk), settings), signature!);
      } catch (error) {
        warning = `embedding unavailable; using BM25 fallback: ${error instanceof Error ? error.message : String(error)}`;
        persistSqliteEmbeddingError(paths.searchIndexPath, chunk.id, warning, signature);
        const event = events.find((item) => item.chunk_id === chunk.id);
        await appendSearchIndexError(paths.searchErrorsPath, {
          schema_version: 1,
          run_id: event?.run_id ?? `search-index-${nowMs()}`,
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

async function sqliteGraphHits(sqlitePath: string, query: string, limit: number): Promise<GraphHit[]> {
  const plan = graphQueryPlan(query);
  if (!plan) return [];
  if (!fssync.existsSync(sqlitePath)) return [];
  const db = new DatabaseSync(sqlitePath);
  try {
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
      const matched = graphMatchScore(row, plan);
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

function graphMatchScore(row: { subject_norm: string; predicate_norm: string; object_norm: string }, plan: GraphQueryPlan): number {
  if (row.predicate_norm !== normalizeGraphText(plan.predicate)) return 0;
  const haystack = plan.knownSide === "subject" ? row.subject_norm : row.object_norm;
  const matches = plan.knownTerms.filter((term) => haystack.includes(term)).length;
  if (matches === 0) return 0;
  const score = matches / Math.max(1, plan.knownTerms.length);
  return score >= graphMatchThreshold(plan.knownTerms.length) ? score : 0;
}

function wantsGraphTraversal(query: string): boolean {
  return Boolean(graphQueryPlan(query));
}

function graphQueryPlan(query: string): GraphQueryPlan | null {
  const relation = graphRelationMatch(query);
  if (!relation) return null;
  const normalized = normalizeWhitespace(query.trim());
  const lower = normalized.toLowerCase();
  const objectDirection = /^(?:what|which|who)\s+(?:endpoints?|interfaces?|commands?|apis?|routes?|entrypoints?)\s+/u.test(lower);
  const subjectQuestion = lower.match(/^(?:what|which)\s+(?:methods?|functions?|apis?)\s+(?:does|do)\s+(.+?)\s+(?:use|uses|used|using|invoke|invokes|invoked|invoking|call|calls|called|calling)\b/u);
  const knownText = subjectQuestion?.[1]
    ?? (objectDirection ? normalized.slice(relation.index + relation.word.length) : normalized.slice(0, relation.index));
  const cleaned = cleanGraphKnownText(knownText);
  const knownTerms = graphKnownTerms(cleaned);
  if (knownTerms.length === 0) return null;
  return {
    predicate: "uses_l3_method",
    knownSide: objectDirection && !subjectQuestion ? "object" : "subject",
    knownText: cleaned,
    knownTerms,
  };
}

function graphRelationMatch(query: string): { word: string; index: number } | null {
  const match = /\b(use|uses|used|using|invoke|invokes|invoked|invoking|call|calls|called|calling)\b/iu.exec(query);
  return match?.[0] ? { word: match[0], index: match.index } : null;
}

function cleanGraphKnownText(text: string): string {
  return text
    .replace(/^[\s:,-]+|[\s:,.?;!-]+$/gu, "")
    .replace(/^(?:the|a|an)\s+/iu, "")
    .replace(/\s+(?:method|methods|function|functions|api|apis|endpoint|endpoints|interface|interfaces|command|commands)$/iu, "")
    .trim();
}

function graphKnownTerms(text: string): string[] {
  const stop = new Set(["what", "which", "who", "does", "do", "the", "a", "an", "method", "methods", "function", "functions", "api", "apis", "endpoint", "endpoints", "interface", "interfaces", "command", "commands", "use", "uses", "used", "using", "invoke", "invokes", "invoked", "invoking", "call", "calls", "called", "calling"]);
  return [...new Set(normalizeGraphText(text).split(/\s+/u).filter((term) => term && !stop.has(term)))].slice(0, 20);
}

function graphMatchThreshold(termCount: number): number {
  if (termCount <= 2) return 1;
  return 0.67;
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
  if (!fssync.existsSync(sqlitePath)) return [];
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

function ensureDirSync(dir: string): void {
  fssync.mkdirSync(dir, { recursive: true });
}
