import http from "node:http";
import { pathToFileURL, URL } from "node:url";
import { configPathFromEnv, createKnowledgeBase, deleteKnowledgeBase, listKnowledgeBases } from "./config.ts";
import * as runtime from "./runtime.ts";
import { HttpError, searchConfigured } from "./search.ts";

let configPath = configPathFromEnv();
let port = 9900;
let printReady = false;

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--port") port = Number(process.argv[++i]);
  else if (arg === "--config") configPath = process.argv[++i];
  else if (arg === "--print-ready") printReady = true;
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  try {
    const result = await route(request, new URL(request.url ?? "/", "http://127.0.0.1"));
    sendJson(response, 200, result);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, status, { error: message });
  }
});

if (isMainModule()) {
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to read server address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    if (printReady) console.log(JSON.stringify({ api_base_url: baseUrl, service: "app" }));
    else console.log(`Wiki Craft API running at ${baseUrl}`);
  });
}

export async function routeForTest(input: { configPath: string; method: string; path: string; body?: unknown }): Promise<unknown> {
  const oldConfigPath = configPath;
  try {
    configPath = input.configPath;
    const request = {
      method: input.method,
      url: input.path,
      async *[Symbol.asyncIterator]() {
        if (input.body !== undefined) yield Buffer.from(JSON.stringify(input.body));
      },
    } as http.IncomingMessage;
    return await route(request, new URL(input.path, "http://127.0.0.1"));
  } finally {
    configPath = oldConfigPath;
  }
}

async function route(request: http.IncomingMessage, url: URL): Promise<unknown> {
  const method = request.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (method === "GET" && url.pathname === "/api/health") return runtime.health();
  if (method === "GET" && url.pathname === "/api/knowledge-bases") return listKnowledgeBases(configPath);
  if (method === "POST" && url.pathname === "/api/knowledge-bases") {
    const body = await jsonBody<{ name: string; focus: string }>(request);
    return { knowledge_base: await createKnowledgeBase(configPath, body) };
  }
  if (method === "DELETE" && parts[0] === "api" && parts[1] === "knowledge-bases" && parts[2]) {
    const body = await jsonBody<{ confirmation_name: string }>(request);
    return deleteKnowledgeBase(configPath, parts[2], body.confirmation_name ?? "");
  }
  if (method === "GET" && url.pathname === "/api/search") {
    return searchConfigured(configPath, url.searchParams.get("knowledge_base") ?? undefined, url.searchParams.get("query") ?? "", Number(url.searchParams.get("top_k") ?? 5), url.searchParams.get("session") ?? undefined, true);
  }
  if (method === "POST" && parts[0] === "api" && parts[1] === "knowledge-bases" && parts[2] && parts[3] === "import-local") {
    const body = await jsonBody<{ path: string; validate?: boolean }>(request);
    return runtime.importLocalFile(configPath, parts[2], body.path, Boolean(body.validate));
  }
  if (method === "POST" && parts[0] === "api" && parts[1] === "knowledge-bases" && parts[2] && parts[3] === "skill") {
    const body = await jsonBody<{ target: "codex" | "claude" | "custom"; destination_path?: string; workflow?: "search" | "author" }>(request);
    return runtime.createSkill(configPath, parts[2], body.target, body.destination_path, body.workflow ?? "search");
  }
  if (method !== "GET") throw new HttpError(405, "method not allowed");
  throw new HttpError(404, "not found");
}

async function jsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as T : {} as T;
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function isMainModule(): boolean {
  return Boolean(process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url);
}
