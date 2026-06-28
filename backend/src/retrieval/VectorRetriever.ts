import type { AppConfig } from "../types.ts";
import { cosine, EmbeddingClient, embeddingsEnabled } from "../knowledge/embeddings.ts";
import type { SearchIndexCache } from "../knowledge/model.ts";

export class VectorRetriever {
  private readonly settings: AppConfig["search"];
  private readonly embeddingClient: EmbeddingClient;

  constructor(settings: AppConfig["search"], embeddingClient = new EmbeddingClient(settings)) {
    this.settings = settings;
    this.embeddingClient = embeddingClient;
  }

  canSearch(cache: SearchIndexCache): boolean {
    return embeddingsEnabled(this.settings) && cache.chunks.some((chunk) => chunk.embedding);
  }

  async search(query: string, cache: SearchIndexCache): Promise<Array<{ id: string; score: number }>> {
    const queryEmbedding = await this.embeddingClient.embed(query);
    return cache.chunks.filter((chunk) => chunk.embedding).map((chunk) => ({
      id: chunk.id,
      score: cosine(queryEmbedding, chunk.embedding!),
    })).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score);
  }
}
