import type { AppConfig, WorkspacePaths } from "../types.ts";
import type { SearchResponse } from "../knowledge/model.ts";
import { KnowledgeDocumentChunker } from "./KnowledgeDocumentChunker.ts";
import { KnowledgeIndexStore } from "./KnowledgeIndexStore.ts";

export async function buildKnowledgeIndex(paths: WorkspacePaths, settings: AppConfig["search"], lexicalOnly = false): Promise<SearchResponse["index_status"]> {
  return new KnowledgeIndexer(paths, settings).build({ lexicalOnly });
}

export class KnowledgeIndexer {
  private readonly chunker: KnowledgeDocumentChunker;
  private readonly store: KnowledgeIndexStore;

  constructor(
    paths: WorkspacePaths,
    settings: AppConfig["search"],
    chunker = new KnowledgeDocumentChunker(),
    store = new KnowledgeIndexStore(paths, settings),
  ) {
    this.chunker = chunker;
    this.store = store;
  }

  async build(options: { lexicalOnly?: boolean } = {}): Promise<SearchResponse["index_status"]> {
    const chunks = await this.chunker.collect(this.store.knowledgeRoot);
    const cache = await this.store.refresh(chunks, { lexicalOnly: options.lexicalOnly ?? false, force: true });
    return {
      indexed_chunks: chunks.length,
      embedded_chunks: cache.chunks.filter((chunk) => chunk.embedding).length,
      stale_vectors: cache.stale_vectors ?? 0,
      graph_edges: cache.graph_edges ?? 0,
      embedding_signature: cache.embedding_signature ?? null,
      warning: cache.embedding_warning ?? null,
    };
  }
}
