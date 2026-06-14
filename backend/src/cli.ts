import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activateKnowledgeBase, configPathFromEnv, createKnowledgeBase, deleteKnowledgeBase, initializeProject, listKnowledgeBases } from "./config.ts";
import * as runtime from "./runtime.ts";
import { reindexConfigured, renderTextResponse, searchConfigured } from "./search.ts";

interface CliOptions {
  config: string;
  args: string[];
}

async function main(): Promise<void> {
  const { config, args } = parseGlobalArgs(process.argv.slice(2));
  const command = args.shift();
  if (!command) return usage();
  if (command === "init") return printJson(await initializeProject(config));
  if (command === "service") return serviceCommand(config, args);
  if (command === "search") {
    const kb = takeOption(args, "--knowledge-base");
    const query = requiredOption(args, "--query");
    const topK = Number(takeOption(args, "--top-k") ?? 5);
    const json = takeFlag(args, "--json");
    const response = await searchConfigured(config, kb, query, topK);
    console.log(json ? JSON.stringify(response, null, 2) : renderTextResponse(response));
    return;
  }
  if (command === "reindex") {
    const kb = takeOption(args, "--knowledge-base");
    return printJson(await reindexConfigured(config, kb, takeFlag(args, "--lexical-only")));
  }
  if (command === "import-local") {
    return printJson(await runtime.importLocalFile(config, requiredOption(args, "--knowledge-base"), requiredOption(args, "--file"), takeFlag(args, "--validate")));
  }
  if (command === "skill") return skillCommand(config, args);
  if (command === "knowledge-base") return knowledgeBaseCommand(config, args);
  throw new Error(`unknown command: ${command}`);
}

async function serviceCommand(config: string, args: string[]): Promise<void> {
  const port = takeOption(args, "--port") ?? "9900";
  const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.ts");
  const child = spawn(process.execPath, [serverPath, "--config", config, "--port", port], { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`service exited with code ${code}`)));
    child.on("error", reject);
  });
}

async function skillCommand(config: string, args: string[]): Promise<void> {
  const command = args.shift();
  if (command !== "create") throw new Error(`unknown skill command: ${command}`);
  const kb = requiredOption(args, "--knowledge-base");
  const target = requiredOption(args, "--target") as "codex" | "claude" | "custom";
  if (!["codex", "claude", "custom"].includes(target)) throw new Error("skill target must be codex, claude, or custom");
  const workflow = takeOption(args, "--workflow") ?? "search";
  if (!["search", "author"].includes(workflow)) throw new Error("skill workflow must be search or author");
  return printJson(await runtime.createSkill(config, kb, target, takeOption(args, "--destination-path"), workflow as "search" | "author"));
}

async function knowledgeBaseCommand(config: string, args: string[]): Promise<void> {
  const command = args.shift();
  if (command === "list") return printJson(await listKnowledgeBases(config));
  if (command === "create") return printJson(await createKnowledgeBase(config, {
    name: requiredOption(args, "--name"),
    focus: requiredOption(args, "--focus"),
  }));
  if (command === "activate") {
    const id = args.shift();
    if (!id) throw new Error("knowledge-base activate requires id");
    console.log(`activated ${(await activateKnowledgeBase(config, id)).id}`);
    return;
  }
  if (command === "delete") {
    const id = args.shift();
    if (!id) throw new Error("knowledge-base delete requires id");
    return printJson(await deleteKnowledgeBase(config, id, requiredOption(args, "--confirmation-name")));
  }
  throw new Error(`unknown knowledge-base command: ${command}`);
}

function parseGlobalArgs(args: string[]): CliOptions {
  const copy = [...args];
  const config = takeOption(copy, "--config") ?? configPathFromEnv();
  return { config, args: copy };
}

function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function requiredOption(args: string[], name: string): string {
  const value = takeOption(args, name);
  if (!value) throw new Error(`missing required option ${name}`);
  return value;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): void {
  console.log("wiki_craft <init|service|search|reindex|import-local|skill|knowledge-base> [options]");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
