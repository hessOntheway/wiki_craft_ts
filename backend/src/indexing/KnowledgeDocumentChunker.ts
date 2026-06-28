import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChunkGraphEdge, SearchChunk } from "../knowledge/model.ts";
import { extractWikilinks, parseVaultFrontmatter } from "../runtime.ts";
import { listFiles, relPosix } from "../util.ts";

export class KnowledgeDocumentChunker {
  async collect(knowledgeRoot: string): Promise<SearchChunk[]> {
  const docs: SearchChunk[] = [];
  for (const file of await listFiles(knowledgeRoot, (candidate) => candidate.endsWith(".md"))) {
    const relative = relPosix(knowledgeRoot, file);
    docs.push(...await this.readDocument(file, knowledgeRoot, relative === "index.md" ? "index" : "topic"));
  }
  return docs.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
}

private async readDocument(file: string, knowledgeRoot: string, kind: SearchChunk["kind"]): Promise<SearchChunk[]> {
  const raw = await fs.readFile(file, "utf8");
  const parsed = parseVaultFrontmatter(raw);
  const relativePath = relPosix(knowledgeRoot, file);
  if (this.codeModelFileExcludedFromSearch(relativePath)) return [];
  const displayPath = relativePath;
  const title = parsed.title ?? this.h1Title(parsed.body);
  const sections = this.codeModelLayerFile(relativePath)
    ? this.codeModelSections(relativePath, parsed.body)
    : this.splitSections(parsed.body);
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

private splitSections(body: string): Array<{ heading?: string | null; text: string; lineOffset: number; graphEdges?: ChunkGraphEdge[] }> {
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

private codeModelSections(relativePath: string, body: string): Array<{ heading?: string | null; text: string; lineOffset: number; graphEdges?: ChunkGraphEdge[] }> {
  const basename = path.posix.basename(relativePath);
  if (basename.startsWith("l1-")) return this.l1CodeModelSections(body);
  if (basename.startsWith("l2-")) return this.l2CodeModelSections(body);
  if (basename.startsWith("l3-")) return this.l3CodeModelSections(body);
  return [];
}

private codeModelFileExcludedFromSearch(relativePath: string): boolean {
  return path.posix.basename(relativePath) === "modeling-guide.md";
}

private codeModelLayerFile(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  return basename.startsWith("l1-") || basename.startsWith("l2-") || basename.startsWith("l3-");
}

private h1Title(body: string): string | undefined {
  return body.split(/\r?\n/u).find((line) => /^#\s+\S/u.test(line))?.replace(/^#\s+/u, "").trim();
}

private l1CodeModelSections(body: string): Array<{ heading?: string | null; text: string; lineOffset: number; graphEdges?: ChunkGraphEdge[] }> {
  const capabilityBlocks = this.subsectionBlocks(body, "Capabilities", 3);
  return capabilityBlocks.filter((block) => this.hasRequiredFields(block.text, [
    "Business goal",
    "Business context",
    "Business domains",
    "Expected outcome",
    "Drill down to L2",
  ])).map((block) => ({
    heading: block.heading,
    text: block.text,
    lineOffset: block.lineOffset,
    graphEdges: this.drillDownEdges(block.heading, block.text),
  }));
}

private l2CodeModelSections(body: string): Array<{ heading?: string | null; text: string; lineOffset: number; graphEdges?: ChunkGraphEdge[] }> {
  const familyHeadings = ["Endpoints", "Commands", "gRPC Methods", "Kafka Consumers"];
  const blocks = familyHeadings.flatMap((family) => this.subsectionBlocks(body, family, 3).map((block) => ({ ...block, family })));
  return blocks.filter((block) => this.hasRequiredFields(block.text, [
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
    graphEdges: this.callsL3Edges(block.heading, block.text),
  }));
}

private l3CodeModelSections(body: string): Array<{ heading?: string | null; text: string; lineOffset: number; graphEdges?: ChunkGraphEdge[] }> {
  const blocks = this.subsectionBlocks(body, "Exported API", 3);
  return blocks.filter((block) => this.hasRequiredFields(block.text, [
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

private hasRequiredFields(text: string, fields: string[]): boolean {
  return fields.every((field) => text.split(/\r?\n/u).some((line) => line.trim().startsWith(`- ${field}:`)));
}

private subsectionBlocks(body: string, parentHeading: string, childLevel: number): Array<{ heading: string; text: string; lineOffset: number }> {
  const lines = body.split(/\r?\n/u);
  const parentLevel = Math.max(1, childLevel - 1);
  const parentPattern = new RegExp(`^#{${parentLevel}}\\s+${this.escapeRegExp(parentHeading)}\\s*$`, "u");
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
    const heading = this.cleanHeadingText(match[1]);
    index += 1;
    while (index < lines.length && !boundaryPattern.test(lines[index])) index += 1;
    blocks.push({ heading, text: lines.slice(start, index).join("\n"), lineOffset: start });
  }
  return blocks;
}

private drillDownEdges(capability: string, text: string): ChunkGraphEdge[] {
  return this.listItemsUnderField(text, "Drill down to L2")
    .flatMap((item) => this.markdownLinkTargets(item))
    .map((target) => ({ subject: capability, predicate: "drills_down_to_l2", object: target }));
}

private callsL3Edges(interfaceName: string, text: string): ChunkGraphEdge[] {
  return this.listItemsUnderField(text, "Calls L3")
    .filter((item) => item !== "None directly; spawns `backend/src/server.ts` with the current Node executable.")
    .map((item) => this.stripMarkdownCode(item))
    .filter(Boolean)
    .map((target) => ({ subject: interfaceName, predicate: "uses_l3_method", object: target }));
}

private listItemsUnderField(text: string, field: string): string[] {
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

private markdownLinkTargets(text: string): string[] {
  const matches = [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)];
  if (matches.length === 0) return [this.stripMarkdownCode(text)];
  return matches.map((match) => `${match[1].trim()} (${match[2].trim()})`);
}

private stripMarkdownCode(text: string): string {
  return text.trim().replace(/^`|`$/gu, "");
}

private cleanHeadingText(text: string): string {
  return this.stripMarkdownCode(text.replace(/\s+#+\s*$/u, ""));
}

private escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
}
