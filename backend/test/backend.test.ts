import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { activateKnowledgeBase, createKnowledgeBase, deleteKnowledgeBase, initializeProject, listKnowledgeBases, loadGlobalConfig } from "../src/config.ts";
import { createSkill, extractWikilinks, importLocalFile, parseVaultFrontmatter } from "../src/runtime.ts";
import { reindexConfigured, searchConfigured } from "../src/search.ts";
import { routeForTest } from "../src/server.ts";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-craft-ts-"));
  const configPath = path.join(root, "wiki_craft.toml");
  await fs.writeFile(configPath, `[runtime]\nroot = ".wiki_craft"\n\n[search]\nembedding_enabled = false\n`);
  return { root, configPath };
}

test("knowledge base registry create/list/activate/delete", async () => {
  const { configPath } = await fixture();
  const one = await createKnowledgeBase(configPath, { name: "Agent Memory", focus: "memory design" });
  const two = await createKnowledgeBase(configPath, { name: "Review Rules", focus: "AI review policy" });
  assert.equal((await listKnowledgeBases(configPath)).active_id, two.id);
  assert.equal((await activateKnowledgeBase(configPath, one.id)).id, one.id);
  await assert.rejects(() => deleteKnowledgeBase(configPath, one.id, "wrong"), /confirmation/);
  const afterDelete = await deleteKnowledgeBase(configPath, one.id, "Agent Memory");
  assert.equal(afterDelete.knowledge_bases.length, 1);
  assert.equal(afterDelete.knowledge_bases[0].id, two.id);
});

test("init creates search-first project files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-craft-init-"));
  const configPath = path.join(root, "wiki_craft.toml");
  const report = await initializeProject(configPath);
  assert.equal(report.config_path, configPath);
  assert.ok(await fs.stat(path.join(root, "WIKI_CRAFT.md")));
  const config = await fs.readFile(configPath, "utf8");
  assert.match(config, /\[search\]/);
  assert.match(config, /embedding_enabled = false/);
});

test("local import writes approved evidence and search sees it", async () => {
  const { root, configPath } = await fixture();
  const kb = await createKnowledgeBase(configPath, { name: "Docs", focus: "docs" });
  const source = path.join(root, "note.md");
  await fs.writeFile(source, "# Note\n\nImportant [[Topic]] content for AI review.");

  const imported = await importLocalFile(configPath, kb.id, source);
  assert.equal(imported.changed, true);
  assert.deepEqual(imported.warnings, []);
  assert.match(imported.summary_path, /^evidence\/source_summaries\//);
  assert.ok(await fs.stat(path.join(kb.root, "knowledge", "approved", imported.summary_path)));

  const again = await importLocalFile(configPath, kb.id, source);
  assert.equal(again.changed, false);

  const response = await searchConfigured(configPath, kb.id, "AI review", 5);
  assert.equal(response.results[0].kind, "source_summary");
  assert.match(response.results[0].snippet, /AI review/);
});

test("validated import reports authoring warnings and preserves frontmatter signals", async () => {
  const { root, configPath } = await fixture();
  const kb = await createKnowledgeBase(configPath, { name: "Authoring", focus: "authoring" });
  const missing = path.join(root, "missing.md");
  await fs.writeFile(missing, "# Loose Report\n\nA long mixed note without the recommended sections.");

  const imported = await importLocalFile(configPath, kb.id, missing, true);
  assert.ok(imported.warnings.some((warning) => warning.includes("missing Summary")));
  const generated = await fs.readFile(path.join(kb.root, "knowledge", "approved", imported.summary_path), "utf8");
  assert.match(generated, /tags: \["imported"\]/);

  const structured = path.join(root, "structured.md");
  await fs.writeFile(structured, "---\ntitle: \"Payment Review\"\naliases: [payments]\ntags: [business-context, review]\n---\n\n# Payment Review\n\n## Summary\n\nPayment risk.\n\n## Exported API\n\n### `reviewPayment(input)`\n\n- Purpose: Review a payment.\n- Parameters:\n  - `input`: Payment input.\n- Returns: Payment review result.\n");
  const structuredImport = await importLocalFile(configPath, kb.id, structured, true);
  assert.deepEqual(structuredImport.warnings, []);
  const structuredGenerated = await fs.readFile(path.join(kb.root, "knowledge", "approved", structuredImport.summary_path), "utf8");
  assert.match(structuredGenerated, /title: "Payment Review"/);
  assert.match(structuredGenerated, /aliases: \["payments"\]/);
  assert.match(structuredGenerated, /tags: \["business-context", "review"\]/);
});

test("frontmatter parsing and wikilinks", () => {
  const parsed = parseVaultFrontmatter("---\ntitle: \"A\"\ntags: [x, y]\n---\n\n# Body\n[[Topic|label]]");
  assert.equal(parsed.title, "A");
  assert.deepEqual(parsed.tags, ["x", "y"]);
  assert.deepEqual(extractWikilinks(parsed.body), ["Topic"]);
});

test("search returns bm25 results with clamped top_k", async () => {
  const { configPath } = await fixture();
  const kb = await createKnowledgeBase(configPath, { name: "Searchable", focus: "search" });
  await fs.writeFile(path.join(kb.root, "knowledge", "approved", "topics", "memory.md"), "---\ntitle: \"Memory\"\ntags: [agent]\n---\n\n# Agent Memory\n\nHybrid retrieval and BM25 index design.");
  const response = await searchConfigured(configPath, kb.id, "BM25 retrieval", 99);
  assert.equal(response.top_k, 20);
  assert.equal(response.retrieval_mode, "bm25");
  assert.equal(response.results[0].kind, "topic");
  const index = path.join(kb.root, "runtime", "search", "index.sqlite");
  assert.ok(await fs.stat(index));
  const status = await reindexConfigured(configPath, kb.id, true);
  assert.equal(status.indexed_chunks, 2);
});

test("code-model reindex chunks strict layers and derives graph edges", async () => {
  const { configPath } = await fixture();
  const kb = await createKnowledgeBase(configPath, { name: "Graphable", focus: "graph search" });
  const codeModel = path.join(kb.root, "knowledge", "approved", "topics", "code-model");
  await fs.mkdir(codeModel, { recursive: true });
  await fs.writeFile(path.join(codeModel, "index.md"), `# Project Index

## Summary

PROJECT_INDEX_ONLY This project index should be read directly for orientation and should not become a search chunk.
`);
  await fs.writeFile(path.join(codeModel, "l1-project-capabilities.md"), `# Project Capability Model

## Summary

PROJECT_OVERVIEW_ONLY Project summary.

## Capabilities

### Approved Search

- Business goal: Search approved knowledge.
- Business context: Review agents need approved retrieval before answering.
- Business domains: Search, indexing.
- Expected outcome: Relevant approved chunks are returned.
- Drill down to L2:
  - [HTTP Endpoints](l2-http-endpoints.md): \`GET /api/search\`

### Skill Export

- Business goal: Generate skills.
- Business context: Users need reusable AI-tool instructions.
- Business domains: Skill export.
- Expected outcome: A skill directory is written.
- Drill down to L2:
  - [HTTP Endpoints](l2-http-endpoints.md): \`POST /api/knowledge-bases/:kb_id/skill\`
`);
  await fs.writeFile(path.join(codeModel, "l2-http-endpoints.md"), `# HTTP Endpoints

## Summary

HTTP API summary.

## Endpoints

### \`GET /api/search\`

- Business goal: Search approved knowledge.
- Business rules:
  - Query text must not be empty.
- Business constraints:
  - Results come from approved knowledge.
- Expected outcome: Ranked approved search results are returned.
- Entry parameters:
  - \`knowledge_base\` (\`query\`, required): Knowledge base ID.
  - \`query\` (\`query\`, required): Search text.
- Calls L3:
  - \`search.searchConfigured(configPath, knowledgeBaseId, query, topK, requireExplicitKnowledgeBase)\`

### \`POST /api/knowledge-bases/:kb_id/skill\`

- Business goal: Generate a skill.
- Business rules:
  - Target knowledge base must exist.
- Business constraints:
  - Custom targets require a destination.
- Expected outcome: A reusable skill is written.
- Entry parameters:
  - \`kb_id\` (\`path\`, required): Knowledge base ID.
- Calls L3:
  - \`runtime.createSkill(configPath, kbId, target, destination, workflow)\`
`);
  await fs.writeFile(path.join(codeModel, "l3-search-module.md"), `# Search Module API

## Summary

Search module summary.

## Exported API

### \`searchConfigured(configPath, knowledgeBaseId, query, topK, requireExplicitKnowledgeBase?)\`

- Business responsibility: Search approved knowledge.
- Business rules:
  - Query text must not be empty.
- Business constraints:
  - Only approved knowledge is searched.
- Expected outcome: Structured search results are returned.
- Parameters:
  - \`query\`: Search text.
- Returns: Search response.

### \`reindexConfigured(configPath, knowledgeBaseId?, lexicalOnly?)\`

- Business responsibility: Rebuild indexes.
- Business rules:
  - A knowledge base must be selected.
- Business constraints:
  - Reindexing reflects approved files.
- Expected outcome: Index status is returned.
- Parameters:
  - \`knowledgeBaseId\`: Knowledge base ID.
- Returns: Index status.
`);
  await fs.writeFile(path.join(codeModel, "l3-legacy-module.md"), `# Legacy Module API

## Summary

This old-format page should not become a code-model chunk.

## Exported API

### \`legacySearch(query)\`

- Purpose: Search approved knowledge.
- Parameters:
  - \`query\`: Search text.
- Returns: Search response.
`);
  await fs.writeFile(path.join(codeModel, "modeling-guide.md"), `# Modeling Guide

## Summary

This format guide should not become a search chunk.
`);

  const status = await reindexConfigured(configPath, kb.id, true);
  assert.equal(status.graph_edges, 4);

  const response = await searchConfigured(configPath, kb.id, "searchConfigured", 5);
  assert.equal(response.retrieval_mode, "bm25");
  assert.ok(response.index_status.graph_edges > 0);
  assert.ok(response.results.every((result) => !result.score_breakdown?.graph));

  const objectGraphResponse = await searchConfigured(configPath, kb.id, "what endpoints use search.searchConfigured", 5);
  assert.equal(objectGraphResponse.retrieval_mode, "graph_hybrid");
  assert.ok(objectGraphResponse.results.some((result) => result.heading === "Endpoints > GET /api/search" && result.supporting_relations?.some((relation) => relation.predicate === "uses_l3_method" && relation.object.includes("search.searchConfigured"))));

  const subjectGraphResponse = await searchConfigured(configPath, kb.id, "what methods does GET /api/search call", 5);
  assert.equal(subjectGraphResponse.retrieval_mode, "graph_hybrid");
  assert.ok(subjectGraphResponse.results.some((result) => result.heading === "Endpoints > GET /api/search" && result.supporting_relations?.some((relation) => relation.subject === "GET /api/search" && relation.object.includes("search.searchConfigured"))));

  const shortSubjectGraphResponse = await searchConfigured(configPath, kb.id, "GET /api/search call", 5);
  assert.equal(shortSubjectGraphResponse.retrieval_mode, "graph_hybrid");
  assert.ok(shortSubjectGraphResponse.results.some((result) => result.heading === "Endpoints > GET /api/search" && result.score_breakdown?.graph));

  const subjectDirectionDoesNotMatchObject = await searchConfigured(configPath, kb.id, "what methods does search.searchConfigured call", 5);
  assert.equal(subjectDirectionDoesNotMatchObject.retrieval_mode, "bm25");
  assert.ok(subjectDirectionDoesNotMatchObject.results.every((result) => !result.score_breakdown?.graph));

  const objectDirectionDoesNotMatchSubject = await searchConfigured(configPath, kb.id, "what endpoints use GET /api/search", 5);
  assert.equal(objectDirectionDoesNotMatchSubject.retrieval_mode, "bm25");
  assert.ok(objectDirectionDoesNotMatchSubject.results.every((result) => !result.score_breakdown?.graph));

  const chineseGraphIntent = await searchConfigured(configPath, kb.id, "哪些接口调用 search.searchConfigured", 5);
  assert.equal(chineseGraphIntent.retrieval_mode, "bm25");
  assert.ok(chineseGraphIntent.results.every((result) => !result.score_breakdown?.graph));

  const dbPath = path.join(kb.root, "runtime", "search", "index.sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    const codeChunks = db.prepare("SELECT chunk_id, heading FROM search_chunks WHERE chunk_id LIKE 'topics/code-model/%' ORDER BY chunk_id").all() as Array<{ chunk_id: string; heading: string }>;
    assert.equal(codeChunks.length, 6);
    assert.ok(codeChunks.some((chunk) => chunk.heading === "Approved Search"));
    assert.ok(codeChunks.some((chunk) => chunk.heading === "Endpoints > GET /api/search"));
    assert.ok(codeChunks.some((chunk) => chunk.heading === "Exported API > searchConfigured(configPath, knowledgeBaseId, query, topK, requireExplicitKnowledgeBase?)"));
    const projectIndex = db.prepare("SELECT COUNT(*) AS count FROM search_chunks WHERE body LIKE '%PROJECT_OVERVIEW_ONLY%' OR body LIKE '%PROJECT_INDEX_ONLY%' OR body LIKE '%old-format page%' OR chunk_id IN ('topics/code-model/modeling-guide.md#0', 'topics/code-model/index.md#0')").get() as { count: number };
    assert.equal(projectIndex.count, 0);
    const l1 = db.prepare("SELECT COUNT(*) AS count FROM search_graph_edges WHERE predicate = 'drills_down_to_l2'").get() as { count: number };
    assert.equal(l1.count, 2);
    const l2 = db.prepare("SELECT COUNT(*) AS count FROM search_graph_edges WHERE predicate = 'uses_l3_method'").get() as { count: number };
    assert.equal(l2.count, 2);
    const metadata = db.prepare("SELECT COUNT(*) AS count FROM search_graph_edges WHERE predicate IN ('has_tag', 'links_to', 'has_source')").get() as { count: number };
    assert.equal(metadata.count, 0);
  } finally {
    db.close();
  }
});

test("single app routes expose only lightweight API", async () => {
  const { configPath } = await fixture();
  const kb = await createKnowledgeBase(configPath, { name: "Routes", focus: "routes" });
  const health = await routeForTest({ configPath, method: "GET", path: "/api/health" }) as { service: string };
  assert.equal(health.service, "app");
  await assert.rejects(() => routeForTest({ configPath, method: "GET", path: "/api/search?query=test" }), (error: unknown) => (error as { status?: number }).status === 400);
  const result = await routeForTest({ configPath, method: "GET", path: `/api/search?knowledge_base=${encodeURIComponent(kb.id)}&query=routes` }) as { query: string };
  assert.equal(result.query, "routes");
  await assert.rejects(() => routeForTest({ configPath, method: "GET", path: `/api/knowledge-bases/${kb.id}/candidates` }), (error: unknown) => (error as { status?: number }).status === 404);
  await assert.rejects(() => routeForTest({ configPath, method: "POST", path: `/api/knowledge-bases/${kb.id}/candidates` }), (error: unknown) => (error as { status?: number }).status === 405);
});

test("skill generation uses fixed CLI search command", async () => {
  const { root, configPath } = await fixture();
  const kb = await createKnowledgeBase(configPath, { name: "Agent Memory", focus: "Agent memory research" });
  await fs.writeFile(path.join(kb.root, "knowledge", "approved", "topics", "retrieval.md"), "---\ntitle: \"Retrieval Patterns\"\naliases: [lookup]\ntags: [memory]\n---\n\n# Retrieval Patterns\n");
  const codeModel = path.join(kb.root, "knowledge", "approved", "topics", "code-model");
  await fs.mkdir(codeModel, { recursive: true });
  await fs.writeFile(path.join(codeModel, "index.md"), `# Agent Memory

## Summary

Agent Memory stores approved knowledge and retrieves it for AI review.
`);
  await fs.writeFile(path.join(codeModel, "l1-agent-memory.md"), `# Agent Memory Code Model

## Summary

Agent Memory stores approved knowledge and retrieves it for AI review.

## Capabilities

### Retrieval

- Business goal: Retrieve knowledge.
- Business context: Review agents need approved retrieval context.
- Business domains: Retrieval.
- Expected outcome: Search interfaces expose approved knowledge.
- Drill down to L2:
  - [Search Interfaces](l2-search.md): \`search\`
`);
  const destination = path.join(root, "skills");
  const outcome = await createSkill(configPath, kb.id, "custom", destination);
  const skill = await fs.readFile(path.join(outcome.skill_path, "SKILL.md"), "utf8");
  assert.equal(outcome.skill_name, "wiki-craft-agent-memory");
  assert.equal(outcome.workflow, "search");
  assert.match(skill, /Retrieval Patterns/);
  assert.match(skill, /npm run wiki-craft -- --config/);
  assert.match(skill, new RegExp(`--knowledge-base '${kb.id}'`));
  assert.doesNotMatch(skill, /Mandatory Modeling Guide/);
  assert.match(skill, /All search queries must be written in English/);
  assert.match(skill, /rewrite the search intent into a concise English query/);
  assert.match(skill, /Replace `<query>` with a concise English natural-language query/);
  assert.match(skill, /Project Index/);
  assert.match(skill, /read the project index file directly first, then run search/);
  assert.match(skill, /topics\/code-model\/index\.md/);
  assert.match(skill, /Project index status: available/);
  assert.doesNotMatch(skill, /Agent Memory stores approved knowledge and retrieves it for AI review/);
  assert.match(skill, /project index -> L1 capability -> L2 interface -> L3 exported API/);
  assert.match(skill, /Drill down to L2/);
  assert.match(skill, /Calls L3/);
  assert.match(skill, /only recognizes English graph-intent words/);
  assert.match(skill, /Queries without one of these exact English words will not use graph relations/);
  assert.match(skill, /subject = L2 interface/);
  assert.match(skill, /object = L3 method/);
  assert.match(skill, /what methods does <interface> call/);
  assert.match(skill, /<interface> call/);
  assert.match(skill, /what endpoints use search\.searchConfigured/);
  assert.doesNotMatch(skill, /cargo run/);
  await assert.rejects(() => createSkill(configPath, kb.id, "custom"), /destination_path is required/);
});

test("author skill generation requires repository modeling guide", async () => {
  const { root, configPath } = await fixture();
  const kb = await createKnowledgeBase(configPath, { name: "Review Knowledge", focus: "AI review business context" });
  const destination = path.join(root, "skills");
  const outcome = await createSkill(configPath, kb.id, "custom", destination, "author");
  const skill = await fs.readFile(path.join(outcome.skill_path, "SKILL.md"), "utf8");
  assert.equal(outcome.skill_name, "wiki-craft-review-knowledge-author");
  assert.equal(outcome.workflow, "author");
  assert.match(skill, /Mandatory Modeling Guide/);
  assert.match(skill, /docs\/code-model\/modeling-guide\.md/);
  assert.match(skill, /If that guide is unavailable, do not use this skill/);
  assert.doesNotMatch(skill, /mandatory fallback contract/i);
  assert.doesNotMatch(skill, /Authoring Contract/);
  assert.doesNotMatch(skill, /L2 Interface Page Format/);
  assert.doesNotMatch(skill, /Calls L3/);
  assert.doesNotMatch(skill, /Forbidden Sections/);
  assert.doesNotMatch(skill, /Code\/Workflow Map/);
  assert.doesNotMatch(skill, /Review Guidance/);
  assert.match(skill, /import-local --knowledge-base/);
  assert.match(skill, /--validate/);
});

test("search index persists embeddings in sqlite and lexical-only clears them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-craft-embed-"));
  const configPath = path.join(root, "wiki_craft.toml");
  await fs.writeFile(configPath, `[runtime]\nroot = ".wiki_craft"\n\n[search]\nembedding_enabled = true\nollama_endpoint = "http://ollama.test"\nembedding_model = "test-model"\nembedding_dimensions = 3\nembedding_timeout_seconds = 1\n`);
  const kb = await createKnowledgeBase(configPath, { name: "Vectors", focus: "vectors" });
  await fs.writeFile(path.join(kb.root, "knowledge", "approved", "topics", "vector.md"), "---\ntitle: \"向量数据库\"\ntags: [检索]\n---\n\n# 向量数据库\n\n中文 向量 数据库 检索.");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ embeddings: [[1, 0, 0]] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    const response = await searchConfigured(configPath, kb.id, "向量数据库", 5);
    assert.ok(response.results.length > 0);
    assert.equal(response.index_status.embedding_signature, "ollama:test-model:3");
  } finally {
    globalThis.fetch = originalFetch;
  }
  const db = new DatabaseSync(path.join(kb.root, "runtime", "search", "index.sqlite"));
  try {
    const embedded = db.prepare("SELECT COUNT(*) AS count FROM search_chunks WHERE embedding IS NOT NULL AND embedding_signature = 'ollama:test-model:3'").get() as { count: number };
    assert.ok(embedded.count > 0);
  } finally {
    db.close();
  }
  const lexical = await reindexConfigured(configPath, kb.id, true);
  assert.equal(lexical.embedded_chunks, 0);
});

test("embedding provider defaults to none without requiring a local service", async () => {
  const { configPath } = await fixture();
  const config = await loadGlobalConfig(configPath);
  assert.equal(config.search.embedding_provider, "none");
  assert.equal(config.search.embedding_enabled, false);
});

test("openai-compatible embedding provider indexes vectors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-craft-openai-embed-"));
  const configPath = path.join(root, "wiki_craft.toml");
  await fs.writeFile(configPath, `[runtime]\nroot = ".wiki_craft"\n\n[search]\nembedding_provider = "openai_compatible"\nembedding_endpoint = "http://embeddings.test/openai/v1"\nembedding_api_key = "test-key"\nembedding_model = "embedding-v1"\nembedding_dimensions = 3\nembedding_timeout_seconds = 1\n`);
  const kb = await createKnowledgeBase(configPath, { name: "Hosted Vectors", focus: "hosted vectors" });
  await fs.writeFile(path.join(kb.root, "knowledge", "approved", "topics", "hosted.md"), "---\ntitle: \"Hosted Embeddings\"\ntags: [vectors]\n---\n\n# Hosted Embeddings\n\nRemote OpenAI compatible embedding APIs.");
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization?: string | null }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      authorization: init?.headers instanceof Headers
        ? init.headers.get("Authorization")
        : (init?.headers as Record<string, string> | undefined)?.Authorization,
    });
    return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const response = await searchConfigured(configPath, kb.id, "hosted embeddings", 5);
    assert.ok(response.results.length > 0);
    assert.equal(response.index_status.embedding_signature, "openai_compatible:embedding-v1:3");
    assert.equal(calls[0]?.url, "http://embeddings.test/openai/v1/embeddings");
    assert.equal(calls[0]?.authorization, "Bearer test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
