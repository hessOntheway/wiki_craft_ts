import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { activateKnowledgeBase, createKnowledgeBase, deleteKnowledgeBase, initializeProject, listKnowledgeBases } from "../src/config.ts";
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
  assert.ok(imported.warnings.some((warning) => warning.includes("missing frontmatter")));
  assert.ok(imported.warnings.some((warning) => warning.includes("missing tags")));
  assert.ok(imported.warnings.some((warning) => warning.includes("missing Evidence")));
  const generated = await fs.readFile(path.join(kb.root, "knowledge", "approved", imported.summary_path), "utf8");
  assert.match(generated, /tags: \["imported"\]/);

  const structured = path.join(root, "structured.md");
  await fs.writeFile(structured, "---\ntitle: \"Payment Review\"\naliases: [payments]\ntags: [business-context, review]\n---\n\n# Payment Review\n\n## Summary\n\nPayment risk.\n\n## Review Guidance\n\nCheck refunds.\n\n## Evidence\n\nbackend/src/payments.ts\n");
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

test("graph index builds approved metadata relations and refreshes stale edges", async () => {
  const { configPath } = await fixture();
  const kb = await createKnowledgeBase(configPath, { name: "Graphable", focus: "graph search" });
  const topic = path.join(kb.root, "knowledge", "approved", "topics", "review.md");
  await fs.writeFile(topic, "---\ntitle: \"Review Rules\"\ntags: [review-policy]\nsource_ids: [source-alpha]\n---\n\n# Review Rules\n\nUse [[Payment Flow]] evidence for review.");

  const response = await searchConfigured(configPath, kb.id, "Payment Flow", 5);
  assert.equal(response.retrieval_mode, "graph_hybrid");
  assert.ok(response.index_status.graph_edges > 0);
  assert.ok((response.results[0].score_breakdown?.graph ?? 0) > 0);
  assert.ok(response.results[0].supporting_relations?.some((relation) => relation.predicate === "links_to" && relation.object === "Payment Flow"));

  const dbPath = path.join(kb.root, "runtime", "search", "index.sqlite");
  let db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM search_graph_edges WHERE predicate IN ('has_tag', 'links_to', 'has_source')").get() as { count: number };
    assert.ok(row.count >= 3);
  } finally {
    db.close();
  }

  await fs.writeFile(topic, "---\ntitle: \"Review Rules\"\ntags: [updated-policy]\n---\n\n# Review Rules\n\nUpdated evidence no longer links the old flow.");
  await reindexConfigured(configPath, kb.id, true);
  db = new DatabaseSync(dbPath);
  try {
    const stale = db.prepare("SELECT COUNT(*) AS count FROM search_graph_edges WHERE object = 'Payment Flow'").get() as { count: number };
    assert.equal(stale.count, 0);
    const fresh = db.prepare("SELECT COUNT(*) AS count FROM search_graph_edges WHERE object = 'updated-policy'").get() as { count: number };
    assert.equal(fresh.count, 1);
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
  const destination = path.join(root, "skills");
  const outcome = await createSkill(configPath, kb.id, "custom", destination);
  const skill = await fs.readFile(path.join(outcome.skill_path, "SKILL.md"), "utf8");
  assert.equal(outcome.skill_name, "wiki-craft-agent-memory");
  assert.equal(outcome.workflow, "search");
  assert.match(skill, /Retrieval Patterns/);
  assert.match(skill, /npm run wiki-craft -- --config/);
  assert.match(skill, new RegExp(`--knowledge-base '${kb.id}'`));
  assert.doesNotMatch(skill, /cargo run/);
  await assert.rejects(() => createSkill(configPath, kb.id, "custom"), /destination_path is required/);
});

test("author skill generation writes code analysis authoring contract", async () => {
  const { root, configPath } = await fixture();
  const kb = await createKnowledgeBase(configPath, { name: "Review Knowledge", focus: "AI review business context" });
  const destination = path.join(root, "skills");
  const outcome = await createSkill(configPath, kb.id, "custom", destination, "author");
  const skill = await fs.readFile(path.join(outcome.skill_path, "SKILL.md"), "utf8");
  assert.equal(outcome.skill_name, "wiki-craft-review-knowledge-author");
  assert.equal(outcome.workflow, "author");
  assert.match(skill, /Authoring Contract/);
  assert.match(skill, /Code\/Workflow Map/);
  assert.match(skill, /Review Guidance/);
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
