import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppConfig, ImportLocalOutcome, SkillCreateOutcome, SkillWorkflow, WorkspacePaths } from "./types.ts";
import { createKnowledgeBase, deleteKnowledgeBase, ensureWorkspace, loadConfigForKnowledgeBase, listKnowledgeBases, workspacePaths } from "./config.ts";
import {
  cleanFrontmatterValue,
  ensureDir,
  escapeTomlString,
  fileUrl,
  listFiles,
  nowMs,
  pathExists,
  readJson,
  sha256Hex,
  slugify,
  sourceIdForUrl,
  truncateChars,
  writeJson,
} from "./util.ts";

interface SourceManifest {
  schema_version: number;
  sources: Record<string, SourceRecord>;
  last_import_unix_ms?: number | null;
}

interface SourceRecord {
  id: string;
  url: string;
  final_url: string;
  title?: string | null;
  content_hash: string;
  version_key: string;
  last_imported_unix_ms: number;
  summary_path: string;
}

interface ProjectIndexSignal {
  path: string;
  title: string;
  summary: string;
}

export async function health(): Promise<{ ok: true; service: "app" }> {
  return { ok: true, service: "app" };
}

export { createKnowledgeBase, deleteKnowledgeBase, listKnowledgeBases };

export async function importLocalFile(configPath: string, kbId: string, file: string, validate = false): Promise<ImportLocalOutcome> {
  const config = await loadConfigForKnowledgeBase(configPath, kbId);
  if (!config.knowledge_base) throw new Error("knowledge base not found");
  const paths = workspacePaths(config);
  await ensureWorkspace(paths);

  const source = await localSource(file, validate);
  const manifest = await loadManifest(paths);
  const summaryPath = path.join(paths.sourceSummariesCurrent, `${source.source_id}.md`);
  const relativeSummaryPath = `evidence/source_summaries/${source.source_id}.md`;
  const existing = manifest.sources[source.source_id];
  const changed = existing?.content_hash !== source.content_hash;

  if (changed) {
    await ensureDir(path.dirname(summaryPath));
    await fs.writeFile(summaryPath, source.markdown);
  }

  manifest.sources[source.source_id] = {
    id: source.source_id,
    url: source.url,
    final_url: source.url,
    title: source.title,
    content_hash: source.content_hash,
    version_key: source.content_hash,
    last_imported_unix_ms: nowMs(),
    summary_path: relativeSummaryPath,
  };
  manifest.last_import_unix_ms = nowMs();
  await saveManifest(paths, manifest);

  return {
    source_id: source.source_id,
    source_url: source.url,
    summary_path: relativeSummaryPath,
    content_hash: source.content_hash,
    changed,
    message: changed ? "local file imported into approved evidence" : "local file is unchanged",
    warnings: source.warnings,
  };
}

export async function createSkill(configPath: string, kbId: string, target: "codex" | "claude" | "custom", destination?: string, workflow: SkillWorkflow = "search"): Promise<SkillCreateOutcome> {
  const config = await loadConfigForKnowledgeBase(configPath, kbId);
  if (!config.knowledge_base) throw new Error("knowledge base not found");
  if (!["search", "author"].includes(workflow)) throw new Error("skill workflow must be search or author");
  const base = resolveSkillDestination(target, destination);
  const skillName = skillSlug(config.knowledge_base.name, config.knowledge_base.id, workflow);
  const skillPath = path.join(base, skillName);
  await ensureDir(skillPath);
  const signals = await collectSkillSignals(config.knowledge_base.root);
  const projectIndex = await collectProjectIndexSignal(config.knowledge_base.root);
  const focus = config.knowledge_base.focus;
  const skill = workflow === "author"
    ? authorSkillMarkdown({ configPath, id: config.knowledge_base.id, name: config.knowledge_base.name, focus, signals, skillName })
    : searchSkillMarkdown({ configPath, id: config.knowledge_base.id, name: config.knowledge_base.name, focus, signals, skillName, projectIndex });
  await fs.writeFile(path.join(skillPath, "SKILL.md"), skill);
  if (target === "codex") {
    await ensureDir(path.join(skillPath, "agents"));
    await fs.writeFile(path.join(skillPath, "agents", "openai.yaml"), `display_name: ${JSON.stringify(workflow === "author" ? `${config.knowledge_base.name} Author` : config.knowledge_base.name)}\nshort_description: ${JSON.stringify(workflow === "author" ? `Write ${config.knowledge_base.name} Wiki Craft topic knowledge` : `Search ${config.knowledge_base.name} approved knowledge`)}\ndefault_prompt: ${JSON.stringify(workflow === "author" ? `Analyze code and produce Wiki Craft topic Markdown for ${config.knowledge_base.name}.` : `Search the ${config.knowledge_base.name} Wiki Craft knowledge base before answering.`)}\n`);
  }
  return { skill_name: skillName, skill_path: skillPath, message: `created ${workflow} skill at ${skillPath}`, workflow };
}

export function parseVaultFrontmatter(text: string): { title?: string; aliases: string[]; tags: string[]; source_ids: string[]; source_urls: string[]; version_hashes: string[]; updated_at_run_id?: string; body: string; body_start_line: number } {
  const blank = { aliases: [], tags: [], source_ids: [], source_urls: [], version_hashes: [] };
  if (!text.startsWith("---\n")) return { ...blank, body: text, body_start_line: 1 };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { ...blank, body: text, body_start_line: 1 };
  const yaml = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/u, "");
  const result: ReturnType<typeof parseVaultFrontmatter> = { ...blank, body, body_start_line: yaml.split(/\r?\n/u).length + 3 };
  for (const line of yaml.split(/\r?\n/u)) {
    const [key, ...rest] = line.split(":");
    if (!key || rest.length === 0) continue;
    const value = rest.join(":").trim();
    const parsed = value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1).split(",").map((item) => cleanFrontmatterValue(item)).filter(Boolean)
      : cleanFrontmatterValue(value);
    const field = key.trim();
    if (["title", "aliases", "tags", "source_ids", "source_urls", "version_hashes", "updated_at_run_id"].includes(field)) {
      (result as Record<string, unknown>)[field] = parsed;
    }
  }
  return result;
}

export function extractWikilinks(text: string): string[] {
  return [...new Set([...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/gu)].map((match) => match[1].trim()).filter(Boolean))].sort();
}

async function localSource(file: string, validate: boolean): Promise<{ source_id: string; url: string; title: string; content_hash: string; markdown: string; warnings: string[] }> {
  const canonical = path.resolve(file);
  const stat = await fs.stat(canonical);
  if (!stat.isFile()) throw new Error(`local source path is not a file: ${canonical}`);
  if (stat.size > 1_000_000) throw new Error(`local source file exceeds maximum size of 1000000 bytes: ${canonical}`);
  const extension = path.extname(canonical).slice(1).toLowerCase();
  const supported = ["md", "markdown", "txt", "json", "csv", "tsv", "toml", "yaml", "yml"];
  if (!supported.includes(extension)) throw new Error(`unsupported local source file extension: ${extension}`);
  const raw = await fs.readFile(canonical, "utf8");
  if (!raw.trim()) throw new Error(`local source file has no readable text: ${canonical}`);
  const url = fileUrl(canonical);
  const sourceId = sourceIdForUrl(url);
  const contentHash = sha256Hex(raw);
  const isMarkdown = extension === "md" || extension === "markdown";
  const parsed = isMarkdown ? parseVaultFrontmatter(raw) : undefined;
  const title = parsed?.title || path.basename(canonical);
  const aliases = parsed?.aliases ?? [];
  const tags = parsed?.tags.length ? parsed.tags : ["imported"];
  const body = isMarkdown
    ? parsed!.body
    : `# ${title}\n\n\`\`\`${fenceInfo(extension)}\n${raw.replaceAll("```", "`\\`\\`")}\n\`\`\`\n`;
  const warnings = validate ? validationWarnings({ raw, body, parsed, tags, isMarkdown }) : [];
  const markdown = `---\ntitle: "${escapeTomlString(title)}"\naliases: ${frontmatterList(aliases)}\ntags: ${frontmatterList(tags)}\nsource_ids: ["${sourceId}"]\nsource_urls: ["${escapeTomlString(url)}"]\nversion_hashes: ["${contentHash}"]\nupdated_at_run_id: "local-import-${nowMs()}"\n---\n\n${body.trimEnd()}\n`;
  return { source_id: sourceId, url, title, content_hash: contentHash, markdown, warnings };
}

function validationWarnings(input: { raw: string; body: string; parsed?: ReturnType<typeof parseVaultFrontmatter>; tags: string[]; isMarkdown: boolean }): string[] {
  const warnings: string[] = [];
  if (!/^#\s+\S+/mu.test(input.body) && !input.parsed?.title) warnings.push("missing page title or H1 heading");
  if (!/^##\s+Summary\b/imu.test(input.body)) warnings.push("missing Summary section");
  for (const section of ["Evidence", "Review Guidance", "Relations", "Graph Triples", "Important Internal Flow", "Review Notes"]) {
    if (new RegExp(`^##\\s+${section}\\b`, "imu").test(input.body)) warnings.push(`deprecated code-model section: ${section}`);
  }
  if (input.body.length > 12_000) warnings.push("document is long; split stable topics into separate pages for better chunks");
  return warnings;
}

function frontmatterList(values: string[]): string {
  return `[${values.map((value) => `"${escapeTomlString(value)}"`).join(", ")}]`;
}

function searchSkillMarkdown(input: { configPath: string; id: string; name: string; focus: string; signals: string[]; skillName: string; projectIndex?: ProjectIndexSignal | null }): string {
  const description = truncateChars(`Use when discussion may benefit from the Wiki Craft knowledge base "${input.name}". Focus: ${input.focus}.${input.signals.length ? ` Approved index/topic signals: ${input.signals.join(", ")}.` : ""} Search this specific knowledge base with Wiki Craft before answering.`, 900);
  const command = `npm run wiki-craft -- --config ${shellQuote(path.resolve(input.configPath))} search --knowledge-base ${shellQuote(input.id)} --query "<query>" --top-k 5 --json`;
  const projectIndexText = input.projectIndex
    ? `- Project index source: \`${input.projectIndex.path}\`\n- Project index title: ${input.projectIndex.title}\n- Project index summary: ${input.projectIndex.summary}`
    : "- Project index source: No code-model L1 Summary was available when this skill was generated.";
  return `---\nname: ${input.skillName}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${input.name}\n\nUse this skill when the user is asking about, designing, comparing, reviewing, or validating work related to this Wiki Craft knowledge base.\n\n## Knowledge Base\n\n- Name: ${input.name}\n- ID: \`${input.id}\`\n- Focus: ${input.focus}\n- Approved index/topic signals: ${input.signals.length ? input.signals.join(", ") : "No approved topic headings were available when this skill was generated."}\n\n## Project Index\n\nBefore searching, read the project index directly for orientation. This overview is intentionally not a search chunk; it comes from the L1 \`## Summary\` in the code-model knowledge base.\n\n${projectIndexText}\n\n## Search Workflow\n\nSearch this exact knowledge base before answering when the conversation overlaps the focus or signals above. Prefer approved \`topic\` and \`index\` results as durable knowledge. Use \`source_summary\` results as evidence and cite returned source URLs when available.\n\nUse the Wiki Craft TS CLI:\n\n\`\`\`bash\n${command}\n\`\`\`\n\nReplace \`<query>\` with a concise natural-language query. Normal searches use keyword and vector hybrid ranking when embeddings are available; otherwise they use BM25.\n\n## Code-Model Graph Retrieval\n\nThe code model is layered as L1 capability -> L2 interface -> L3 exported API. L1 graph relations come from exact \`Drill down to L2\` fields, and L2 graph relations come from exact \`Calls L3\` fields.\n\nFor L2 -> L3 graph edges, the triple shape is fixed: \`subject = L2 interface\`, \`predicate = uses_l3_method\`, and \`object = L3 method\`.\n\nGraph retrieval is intentionally opt-in and only recognizes English graph-intent words. If you need to follow usage or invocation relationships, the query must include one of these English words: \`use\`, \`uses\`, \`used\`, \`using\`, \`invoke\`, \`invokes\`, \`invoked\`, \`invoking\`, \`call\`, \`calls\`, \`called\`, or \`calling\`. Queries without one of these exact English words will not use graph relations.\n\nRewrite graph questions into one of these English forms before searching:\n\n- To ask which interfaces call a known method, use \`which endpoints use <module.method>\`.\n- To ask what methods an interface calls, use \`what methods does <interface> call\`.\n- For short caller queries, use \`<interface> call\`.\n\nExamples:\n\n\`\`\`bash\n${command.replace("<query>", "search knowledge base registry")}\n${command.replace("<query>", "what endpoints use search.searchConfigured")}\n${command.replace("<query>", "what methods does GET /api/search call")}\n${command.replace("<query>", "GET /api/search call")}\n\`\`\`\n\nOnly treat returned approved knowledge as authoritative.\n`;
}

function authorSkillMarkdown(input: { configPath: string; id: string; name: string; focus: string; signals: string[]; skillName: string }): string {
  const description = truncateChars(`Use when producing structured Wiki Craft topic Markdown for "${input.name}" from code analysis. Focus: ${input.focus}. Follow the authoring contract so future AI code review can retrieve accurate business and code context.`, 900);
  const importCommand = `npm run wiki-craft -- --config ${shellQuote(path.resolve(input.configPath))} import-local --knowledge-base ${shellQuote(input.id)} --file "<topic.md>" --validate`;
  return `---\nname: ${input.skillName}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${input.name} Authoring\n\nUse this skill when analyzing source code to produce Wiki Craft code-model Markdown for AI code review. Do not edit the user's repository or approved vault directly. Produce Markdown files that the user can inspect and import.\n\n## Knowledge Base\n\n- Name: ${input.name}\n- ID: \`${input.id}\`\n- Focus: ${input.focus}\n- Existing signals: ${input.signals.length ? input.signals.join(", ") : "No approved topic headings were available when this skill was generated."}\n\n## Mandatory Format Source\n\nBefore authoring, read \`docs/code-model/modeling-guide.md\` from the target repository when it exists. You must follow that guide exactly. If the guide is unavailable, follow the mandatory fallback contract below exactly.\n\nThe exact headings and field labels are part of the indexing contract. Do not rename them, translate them, omit them, or replace them with synonyms.\n\n## Authoring Contract\n\nEach generated file must be one stable code-model page, not a long mixed report. Do not add YAML frontmatter. Do not create \`index.md\` pages. Use H1 as the first line.\n\n## L1 Capability Page Format\n\nUse L1 for project-level capability summaries. L1 must drill down only to L2 pages, never directly to L3 methods or source modules.\n\n\`\`\`md\n# <Project Or Repository Model>\n\n## Summary\n\n## Capabilities\n\n### <Capability Name>\n\n- Business function:\n- Drill down to L2:\n  - [<L2 page title>](<l2-file.md>): <interface names>\n\`\`\`\n\nRequired L1 keywords: \`## Summary\`, \`## Capabilities\`, \`- Business function:\`, \`- Drill down to L2:\`.\n\n## L2 Interface Page Format\n\nUse L2 for external interfaces. Treat HTTP endpoints, CLI commands, gRPC methods, Kafka consumers, scheduled jobs, and other stable external entrypoints as interfaces. The interface-family heading must be one of the exact headings below when applicable: \`## Endpoints\`, \`## Commands\`, \`## gRPC Methods\`, \`## Kafka Consumers\`.\n\n\`\`\`md\n# <Interface Family Title>\n\n## Summary\n\n## Endpoints\n\n### <INTERFACE NAME>\n\n- Business function:\n- Entry parameters:\n- Calls L3:\n  - \`module.method(signature)\`\n\`\`\`\n\nRequired L2 keywords: \`## Summary\`, an interface-family heading such as \`## Endpoints\` or \`## Commands\`, \`- Business function:\`, \`- Entry parameters:\`, and \`- Calls L3:\`.\n\nGraph indexing is derived from L2. Do not hand-author \`Graph Triples\`; the index builder reads each interface heading and its \`Calls L3\` list.\n\n## L3 Exported API Page Format\n\nUse L3 for exported functions, exported classes and public methods, or important object boundaries. Do not create L3 pages for pure type/interface collections or generic utility-only modules.\n\n\`\`\`md\n# <Module Or Object API>\n\n## Summary\n\n## Exported API\n\n### \`functionName(signature)\`\n\n- Purpose:\n- Parameters:\n  - \`parameterName\`: <meaning>\n- Returns:\n\`\`\`\n\nRequired L3 keywords: \`## Summary\`, \`## Exported API\`, \`- Purpose:\`, \`- Parameters:\`, and \`- Returns:\`.\n\n## Forbidden Sections\n\nDo not include these sections in generated code-model pages: \`## Relations\`, \`## Evidence\`, \`## Review Notes\`, \`## Important Internal Flow\`, or \`## Graph Triples\`.\n\n## Writing Rules\n\n- Keep each page focused on one layer unit: one capability page, one interface family, or one exported API module/object.\n- Keep each capability, interface, or exported method in its own subsection so chunking keeps the name and required fields together.\n- Preserve searchable names in headings and fields: endpoint paths, command names, gRPC method names, Kafka topic or consumer names, function names, config keys, and source file paths when useful.\n- Mark uncertainty in plain text inside the relevant field instead of inventing sections.\n- Prefer several short model files over one large mixed report when code spans unrelated capabilities or interfaces.\n\n## Import Check\n\nAfter the user reviews a generated topic file, they can import it with validation:\n\n\`\`\`bash\n${importCommand}\n\`\`\`\n`;
}

function fenceInfo(extension: string): string {
  if (extension === "yml") return "yaml";
  if (extension === "tsv") return "";
  return extension;
}

async function loadManifest(paths: WorkspacePaths): Promise<SourceManifest> {
  return readJson<SourceManifest>(paths.manifestPath, { schema_version: 1, sources: {}, last_import_unix_ms: null });
}

async function saveManifest(paths: WorkspacePaths, manifest: SourceManifest): Promise<void> {
  await writeJson(paths.manifestPath, manifest);
}

async function collectSkillSignals(kbRoot: string): Promise<string[]> {
  const approved = path.join(kbRoot, "knowledge", "approved");
  const signals = new Set<string>();
  await collectMarkdownSignals(path.join(approved, "index.md"), signals);
  for (const file of await listFiles(path.join(approved, "topics"), (candidate) => candidate.endsWith(".md"))) {
    await collectMarkdownSignals(file, signals);
    if (signals.size >= 18) break;
  }
  return [...signals].sort().slice(0, 12);
}

async function collectProjectIndexSignal(kbRoot: string): Promise<ProjectIndexSignal | null> {
  const codeModelRoot = path.join(kbRoot, "knowledge", "approved", "topics", "code-model");
  const files = (await listFiles(codeModelRoot, (candidate) => path.basename(candidate).startsWith("l1-") && candidate.endsWith(".md"))).sort();
  for (const file of files) {
    const parsed = parseVaultFrontmatter(await fs.readFile(file, "utf8"));
    const summary = markdownSection(parsed.body, "Summary");
    if (!summary) continue;
    return {
      path: file,
      title: parsed.title ?? h1Title(parsed.body) ?? path.basename(file),
      summary: truncateChars(summary, 900),
    };
  }
  return null;
}

function markdownSection(body: string, heading: string): string | null {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return null;
  const out: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index])) break;
    out.push(lines[index]);
  }
  const text = out.join("\n").trim();
  return text || null;
}

function h1Title(body: string): string | undefined {
  return body.split(/\r?\n/u).find((line) => /^#\s+\S/u.test(line))?.replace(/^#\s+/u, "").trim();
}

async function collectMarkdownSignals(file: string, signals: Set<string>): Promise<void> {
  if (!(await pathExists(file))) return;
  const parsed = parseVaultFrontmatter(await fs.readFile(file, "utf8"));
  insertSignal(signals, parsed.title);
  for (const value of [...parsed.aliases, ...parsed.tags]) insertSignal(signals, value);
  for (const line of parsed.body.split(/\r?\n/u)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/u)?.[1];
    insertSignal(signals, heading);
    if (signals.size >= 24) break;
  }
}

function insertSignal(signals: Set<string>, value?: string | null): void {
  const trimmed = value?.trim();
  if (trimmed && [...trimmed].length >= 2) signals.add(trimmed);
}

function resolveSkillDestination(target: "codex" | "claude" | "custom", destination?: string): string {
  const custom = destination?.trim();
  if (target === "custom") {
    if (!custom) throw new Error("destination_path is required when target is custom");
    return expandHome(custom);
  }
  if (custom) return expandHome(custom);
  const home = process.env.HOME;
  if (!home) throw new Error(`cannot resolve ${target} skills directory; set HOME or destination_path`);
  return target === "claude" ? path.join(home, ".claude", "skills") : path.join(home, ".codex", "skills");
}

function skillSlug(name: string, fallbackId: string, workflow: SkillWorkflow = "search"): string {
  const primary = slugify(name, "");
  const base = primary || slugify(fallbackId, "");
  const slug = !base || base.startsWith("wiki-craft") ? base : `wiki-craft-${base}`;
  const full = workflow === "author" ? `${slug || "wiki-craft-knowledge-base"}-author` : (slug || "wiki-craft-knowledge-base");
  return truncateChars(full.replace(/^-+|-+$/gu, ""), 80) || "wiki-craft-knowledge-base";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function expandHome(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) return path.join(process.env.HOME ?? ".", value.slice(2));
  return value;
}
