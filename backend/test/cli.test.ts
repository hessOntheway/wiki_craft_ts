import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const CLI = path.resolve("backend/src/cli.ts");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function fixture(): Promise<{ root: string; configPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-craft-cli-"));
  return { root, configPath: path.join(root, "wiki_craft.toml") };
}

async function runCli(configPath: string, args: string[], cwd = path.dirname(configPath)): Promise<CliResult> {
  const child = spawn(process.execPath, [CLI, "--config", configPath, ...args], { cwd });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

function parseJson<T>(result: CliResult): T {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as T;
}

test("CLI init, knowledge-base, import, search, reindex, and skill flow", async () => {
  const { root, configPath } = await fixture();
  const init = parseJson<{ created: string[] }>(await runCli(configPath, ["init"], root));
  assert.ok(init.created.some((file) => file.endsWith("wiki_craft.toml")));

  const kb = parseJson<{ id: string; name: string; root: string }>(await runCli(configPath, ["knowledge-base", "create", "--name", "CLI Docs", "--focus", "cli search"]));
  assert.equal(kb.name, "CLI Docs");

  const list = parseJson<{ active_id: string; knowledge_bases: unknown[] }>(await runCli(configPath, ["knowledge-base", "list"]));
  assert.equal(list.active_id, kb.id);
  assert.equal(list.knowledge_bases.length, 1);

  const source = path.join(root, "source.md");
  await fs.writeFile(source, "# CLI Source\n\nSearch parity and direct local import.");
  const imported = parseJson<{ changed: boolean; summary_path: string; warnings: string[] }>(await runCli(configPath, ["import-local", "--knowledge-base", kb.id, "--file", source, "--validate"]));
  assert.equal(imported.changed, true);
  assert.match(imported.summary_path, /^evidence\/source_summaries\//);
  assert.ok(imported.warnings.some((warning) => warning.includes("missing frontmatter")));

  const search = parseJson<{ retrieval_mode: string; index_status: { graph_edges: number }; results: Array<{ title: string; score_breakdown?: { graph?: number } }> }>(await runCli(configPath, ["search", "--knowledge-base", kb.id, "--query", "direct local import", "--json"]));
  assert.equal(search.retrieval_mode, "graph_hybrid");
  assert.ok(search.results.length > 0);
  assert.ok(search.index_status.graph_edges > 0);

  const graphText = await runCli(configPath, ["search", "--knowledge-base", kb.id, "--query", "imported"]);
  assert.equal(graphText.code, 0, graphText.stderr);
  assert.match(graphText.stdout, /related:/);

  const reindex = parseJson<{ indexed_chunks: number }>(await runCli(configPath, ["reindex", "--knowledge-base", kb.id, "--lexical-only"]));
  assert.equal(reindex.indexed_chunks, 2);

  const skillDir = path.join(root, "skills");
  const skill = parseJson<{ skill_path: string; workflow: string }>(await runCli(configPath, ["skill", "create", "--knowledge-base", kb.id, "--target", "custom", "--destination-path", skillDir]));
  const skillBody = await fs.readFile(path.join(skill.skill_path, "SKILL.md"), "utf8");
  assert.equal(skill.workflow, "search");
  assert.match(skillBody, /CLI Docs/);
  assert.match(skillBody, /npm run wiki-craft -- --config/);

  const authorSkill = parseJson<{ skill_path: string; workflow: string }>(await runCli(configPath, ["skill", "create", "--knowledge-base", kb.id, "--target", "custom", "--destination-path", skillDir, "--workflow", "author"]));
  const authorBody = await fs.readFile(path.join(authorSkill.skill_path, "SKILL.md"), "utf8");
  assert.equal(authorSkill.workflow, "author");
  assert.match(authorBody, /Authoring Contract/);
  assert.match(authorBody, /Code\/Workflow Map/);

  const removed = await runCli(configPath, ["candidates", "list"]);
  assert.notEqual(removed.code, 0);
  assert.match(removed.stderr, /unknown command: candidates/);
});
