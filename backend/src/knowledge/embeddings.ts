import type { AppConfig } from "../types.ts";

export function embeddingsEnabled(settings: AppConfig["search"]): boolean {
  return settings.embedding_provider !== "none";
}

export function embeddingSignature(settings: AppConfig["search"]): string {
  return `${settings.embedding_provider}:${settings.embedding_model}:${settings.embedding_dimensions}`;
}

export class EmbeddingClient {
  private readonly settings: AppConfig["search"];

  constructor(settings: AppConfig["search"]) {
    this.settings = settings;
  }

  embed(text: string): Promise<number[]> {
    return embed(text, this.settings);
  }
}

export async function embed(text: string, settings: AppConfig["search"]): Promise<number[]> {
  if (settings.embedding_provider === "ollama") return embedWithOllama(text, settings);
  if (settings.embedding_provider === "openai_compatible") return embedWithOpenAiCompatible(text, settings);
  throw new Error("embedding provider is disabled");
}

export function cosine(left: number[], right: number[]): number {
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
