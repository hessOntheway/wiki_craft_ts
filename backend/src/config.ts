import { promises as fs } from "node:fs";
import * as fssync from "node:fs";
import path from "node:path";
import type { AppConfig, EmbeddingProvider, KnowledgeBaseList, KnowledgeBaseRecord, WorkspacePaths } from "./types.ts";
import { ensureDir, escapeTomlString, nowMs, pathExists, pathExistsSync, readJson, slugify, writeJson } from "./util.ts";

const DEFAULT_CONFIG_PATH = "wiki_craft.toml";
const DEFAULT_RUNTIME_ROOT = ".wiki_craft";
const KB_DIR = "knowledge_bases";
const REGISTRY_FILE = "registry.json";
const KB_CONFIG_FILE = "knowledge_base.toml";
const DEFAULT_SCHEMA_PATH = "WIKI_CRAFT.md";

type TomlValue = string | number | boolean | string[] | Record<string, unknown> | TomlValue[];
type TomlObject = Record<string, TomlValue>;

export function configPathFromEnv(): string {
  const configured = process.env.WIKI_CRAFT_CONFIG?.trim();
  if (configured) return absolutePath(configured);
  const discovered = discoverDefaultConfigPath();
  return discovered ?? absolutePath(DEFAULT_CONFIG_PATH);
}

export async function initializeProject(configPath: string): Promise<{ config_path: string; schema_path: string; runtime_root: string; created: string[]; existing: string[] }> {
  const absolute = absolutePath(configPath);
  const base = path.dirname(absolute);
  const created: string[] = [];
  const existing: string[] = [];
  if (await pathExists(absolute)) existing.push(absolute);
  else {
    await ensureDir(base);
    await fs.writeFile(absolute, defaultConfigToml());
    created.push(absolute);
  }

  const config = await loadGlobalConfig(absolute);
  const schemaPath = path.join(base, DEFAULT_SCHEMA_PATH);
  if (await pathExists(schemaPath)) existing.push(schemaPath);
  else {
    await fs.writeFile(schemaPath, defaultSchemaMarkdown());
    created.push(schemaPath);
  }

  const registry = knowledgeBaseRegistryPath(config);
  if (await pathExists(registry)) existing.push(registry);
  else {
    await writeJson(registry, { schema_version: 1, active_id: null, knowledge_bases: [] });
    created.push(registry);
  }
  await ensureDir(path.join(config.runtime.root, "runtime"));
  created.push(config.runtime.root);
  return { config_path: absolute, schema_path: DEFAULT_SCHEMA_PATH, runtime_root: config.runtime.root, created, existing };
}

export async function listKnowledgeBases(configPath: string): Promise<KnowledgeBaseList> {
  const config = await loadGlobalConfig(configPath);
  return readJson<KnowledgeBaseList>(knowledgeBaseRegistryPath(config), { active_id: null, knowledge_bases: [] });
}

export async function createKnowledgeBase(configPath: string, input: { name: string; focus: string }): Promise<KnowledgeBaseRecord> {
  const config = await loadGlobalConfig(configPath);
  const name = requiredText(input.name, "knowledge base name");
  const focus = requiredText(input.focus, "knowledge base focus");
  const now = nowMs();
  const id = `${slugify(name, "knowledge-base")}-${now}`;
  const root = path.join(knowledgeBasesRoot(config), id);
  const record: KnowledgeBaseRecord = { id, name, focus, root, created_at_unix_ms: now, updated_at_unix_ms: now };

  await ensureDir(path.join(root, "knowledge", "approved", "topics"));
  await ensureDir(path.join(root, "knowledge", "approved", "evidence", "source_summaries"));
  await ensureDir(path.join(root, "knowledge", "approved", "evidence", "sources"));
  await ensureDir(path.join(root, "runtime"));
  await fs.writeFile(path.join(root, KB_CONFIG_FILE), knowledgeBaseToml(name, focus));
  await fs.writeFile(
    path.join(root, "knowledge", "approved", "index.md"),
    `---\ntitle: "${escapeTomlString(name)}"\naliases: []\ntags: [index]\nsource_ids: []\nsource_urls: []\nversion_hashes: []\n---\n\n# ${name}\n\nFocus: ${focus}\n`,
  );

  const registry = await listKnowledgeBases(configPath);
  registry.knowledge_bases.push(record);
  registry.active_id = id;
  await writeJson(knowledgeBaseRegistryPath(config), {
    schema_version: 1,
    active_id: registry.active_id,
    knowledge_bases: registry.knowledge_bases,
  });
  return record;
}

export async function deleteKnowledgeBase(configPath: string, id: string, confirmationName: string): Promise<KnowledgeBaseList> {
  const config = await loadGlobalConfig(configPath);
  const registry = await listKnowledgeBases(configPath);
  const index = registry.knowledge_bases.findIndex((kb) => kb.id === id);
  if (index < 0) throw new Error(`knowledge base not found: ${id}`);
  const record = registry.knowledge_bases[index];
  if (confirmationName.trim() !== record.name) throw new Error("knowledge base name confirmation did not match");
  ensureDeletableRoot(record.root, knowledgeBasesRoot(config));
  await fs.rm(record.root, { recursive: true, force: true });
  registry.knowledge_bases.splice(index, 1);
  if (registry.active_id === id) registry.active_id = registry.knowledge_bases[0]?.id ?? null;
  await writeJson(knowledgeBaseRegistryPath(config), {
    schema_version: 1,
    active_id: registry.active_id,
    knowledge_bases: registry.knowledge_bases,
  });
  return registry;
}

export async function activateKnowledgeBase(configPath: string, id: string): Promise<KnowledgeBaseRecord> {
  const config = await loadGlobalConfig(configPath);
  const registry = await listKnowledgeBases(configPath);
  const trimmed = requiredText(id, "knowledge base id");
  const record = registry.knowledge_bases.find((kb) => kb.id === trimmed);
  if (!record) throw new Error(`knowledge base not found: ${trimmed}`);
  registry.active_id = record.id;
  await writeJson(knowledgeBaseRegistryPath(config), {
    schema_version: 1,
    active_id: registry.active_id,
    knowledge_bases: registry.knowledge_bases,
  });
  return record;
}

export async function loadConfigForKnowledgeBase(configPath: string, id?: string | null): Promise<AppConfig> {
  const config = await loadGlobalConfig(configPath);
  const registry = await readJson<KnowledgeBaseList>(knowledgeBaseRegistryPath(config), { active_id: null, knowledge_bases: [] });
  const selectedId = id?.trim() || registry.active_id || undefined;
  if (!selectedId) return config;
  const record = registry.knowledge_bases.find((kb) => kb.id === selectedId);
  if (!record) throw new Error(`knowledge base not found in registry: ${selectedId}`);
  const kbToml = await parseTomlFile(path.join(record.root, KB_CONFIG_FILE));
  config.knowledge_base = {
    id: record.id,
    name: String(kbToml.name ?? record.name),
    focus: String(kbToml.focus ?? record.focus),
    root: record.root,
  };
  return config;
}

export async function loadGlobalConfig(configPath: string): Promise<AppConfig> {
  const absolute = absolutePath(configPath);
  const raw = (await pathExists(absolute)) ? await parseTomlFile(absolute) : {};
  const base = path.dirname(absolute);
  const runtime = objectAt(raw, "runtime");
  const search = objectAt(raw, "search");
  return {
    configPath: absolute,
    runtime: {
      root: resolveRelative(base, stringAt(runtime, "root", DEFAULT_RUNTIME_ROOT)),
    },
    search: {
      embedding_enabled: booleanAt(search, "embedding_enabled", false),
      embedding_provider: embeddingProviderAt(search),
      embedding_endpoint: stringAt(search, "embedding_endpoint", ""),
      embedding_api_key: optionalStringAt(search, "embedding_api_key"),
      ollama_endpoint: stringAt(search, "ollama_endpoint", "http://127.0.0.1:11434"),
      embedding_model: stringAt(search, "embedding_model", "bge-m3"),
      embedding_dimensions: numberAt(search, "embedding_dimensions", 1024),
      embedding_timeout_seconds: numberAt(search, "embedding_timeout_seconds", 10),
    },
  };
}

export function workspacePaths(config: AppConfig): WorkspacePaths {
  const root = config.knowledge_base?.root ?? config.runtime.root;
  const approvedKnowledge = path.join(root, "knowledge", "approved");
  const approvedEvidence = path.join(approvedKnowledge, "evidence");
  return {
    root,
    knowledgeBaseId: config.knowledge_base?.id,
    knowledgeBaseName: config.knowledge_base?.name,
    knowledgeBaseFocus: config.knowledge_base?.focus,
    sourcesDir: path.join(approvedEvidence, "sources"),
    sourceSummariesCurrent: path.join(approvedEvidence, "source_summaries"),
    knowledgeCurrent: approvedKnowledge,
    manifestPath: path.join(approvedEvidence, "sources", "manifest.json"),
    searchIndexPath: path.join(root, "runtime", "search", "index.sqlite"),
    searchCachePath: path.join(root, "runtime", "search", "index.json"),
  };
}

export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.root),
    ensureDir(paths.sourcesDir),
    ensureDir(paths.sourceSummariesCurrent),
    ensureDir(paths.knowledgeCurrent),
    ensureDir(path.dirname(paths.searchIndexPath)),
  ]);
}

export function knowledgeBaseRegistryPath(config: AppConfig): string {
  return path.join(knowledgeBasesRoot(config), REGISTRY_FILE);
}

export function knowledgeBasesRoot(config: AppConfig): string {
  return path.join(config.runtime.root, KB_DIR);
}

async function parseTomlFile(file: string): Promise<TomlObject> {
  return parseToml(await fs.readFile(file, "utf8"));
}

function parseToml(text: string): TomlObject {
  const root: TomlObject = {};
  let current: Record<string, TomlValue> = root;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const section = line.match(/^\[(.+)\]$/u);
    if (section) {
      current = ensureSection(root, section[1].split(".").map((key) => key.trim()));
      continue;
    }
    const [key, ...rest] = line.split("=");
    if (!key || rest.length === 0) continue;
    current[key.trim()] = parseTomlValue(rest.join("=").trim());
  }
  return root;
}

function parseTomlValue(value: string): TomlValue {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => String(parseTomlValue(item.trim())));
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function ensureSection(root: TomlObject, keys: string[]): Record<string, TomlValue> {
  let current: Record<string, TomlValue> = root;
  for (const key of keys) {
    const existing = current[key];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[key] = {};
    current = current[key] as Record<string, TomlValue>;
  }
  return current;
}

function stripTomlComment(line: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== "\\") inQuote = inQuote === ch ? null : inQuote ?? ch;
    if (ch === "#" && !inQuote) return line.slice(0, i);
  }
  return line;
}

function objectAt(root: TomlObject, key: string): Record<string, unknown> {
  const value = root[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringAt(root: Record<string, unknown>, key: string, fallback: string): string {
  const value = root[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function optionalStringAt(root: Record<string, unknown>, key: string): string | null {
  const value = root[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function embeddingProviderAt(root: Record<string, unknown>): EmbeddingProvider {
  const raw = typeof root.embedding_provider === "string" ? root.embedding_provider.trim().toLowerCase() : "";
  if (raw === "none" || raw === "ollama" || raw === "openai_compatible") return raw;
  return booleanAt(root, "embedding_enabled", false) ? "ollama" : "none";
}

function numberAt(root: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(root[key]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanAt(root: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof root[key] === "boolean" ? Boolean(root[key]) : fallback;
}

function requiredText(value: string, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function resolveRelative(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(base, value);
}

function absolutePath(value: string): string {
  return path.resolve(value);
}

function discoverDefaultConfigPath(): string | null {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, DEFAULT_CONFIG_PATH);
    if (pathExistsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function ensureDeletableRoot(root: string, parent: string): void {
  const resolved = path.resolve(root);
  const resolvedParent = path.resolve(parent);
  if (!resolved.startsWith(`${resolvedParent}${path.sep}`)) throw new Error(`refusing to delete outside knowledge base root: ${root}`);
  if (!fssync.existsSync(resolved)) return;
}

function knowledgeBaseToml(name: string, focus: string): string {
  return `name = "${escapeTomlString(name)}"\nfocus = "${escapeTomlString(focus)}"\n`;
}

function defaultConfigToml(): string {
  return `# Wiki Craft configuration.\n\n[runtime]\nroot = ".wiki_craft"\n\n[search]\n# Embeddings are optional. Use "none" for BM25/graph-only search, "ollama"\n# for a local Ollama embedder, or "openai_compatible" for a /v1/embeddings API.\nembedding_enabled = false\nembedding_provider = "none"\nembedding_endpoint = ""\nembedding_api_key = ""\nollama_endpoint = "http://127.0.0.1:11434"\nembedding_model = "bge-m3"\nembedding_dimensions = 1024\nembedding_timeout_seconds = 10\n`;
}

function defaultSchemaMarkdown(): string {
  return `# Wiki Craft Schema\n\nThis file is the operating contract for approved knowledge used by Wiki Craft search and authoring.\n\n## Knowledge Base Location\n\nAI coding tools should read approved knowledge from:\n\n- \`.wiki_craft/knowledge_bases/{id}/knowledge/approved/index.md\`\n- \`.wiki_craft/knowledge_bases/{id}/knowledge/approved/topics/*.md\`\n- \`.wiki_craft/knowledge_bases/{id}/knowledge/approved/evidence/source_summaries/\`\n\n## Rules\n\n- Treat approved Markdown as authoritative for the selected knowledge base.\n- Local imports are considered user-approved evidence and are written directly under approved evidence.\n- Prefer concise Markdown pages with links back to source URLs when available.\n- Mark conflicts, uncertainty, and changed claims explicitly.\n\n## Approved Topic Authoring Contract\n\nUse this frontmatter shape for topic and evidence-summary Markdown:\n\n\`\`\`yaml\n---\ntitle: \"<stable topic name>\"\naliases: []\ntags: []\nsource_ids: []\nsource_urls: []\nversion_hashes: []\n---\n\`\`\`\n\nRecommended topic sections:\n\n\`\`\`md\n# <stable topic name>\n\n## Summary\n\n## Business Context\n\n## Code/Workflow Map\n\n## Review Guidance\n\n## Relations\n\n## Evidence\n\n## Conflicts & Uncertainties\n\`\`\`\n\nChunk quality rules:\n\n- Keep one page focused on one stable topic, workflow, business rule, integration, or review risk.\n- Avoid long mixed reports; split unrelated concepts into separate topic pages.\n- Put important searchable concepts in headings, tags, aliases, wikilinks, or concise paragraphs.\n- Preserve code evidence as file paths, symbols, endpoints, config keys, source URLs, or version notes.\n- Tags are authored or normalized before indexing; reindex does not infer new tags.\n`;
}
