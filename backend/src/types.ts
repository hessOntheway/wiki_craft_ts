export type RetrievalMode = "hybrid" | "bm25" | "graph_hybrid";
export type EmbeddingProvider = "none" | "ollama" | "openai_compatible";

export interface KnowledgeBaseRecord {
  id: string;
  name: string;
  focus: string;
  root: string;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
}

export interface KnowledgeBaseList {
  active_id?: string | null;
  knowledge_bases: KnowledgeBaseRecord[];
}

export type SkillWorkflow = "search" | "author";

export interface SkillCreateOutcome {
  skill_name: string;
  skill_path: string;
  message: string;
  workflow: SkillWorkflow;
}

export interface WorkspacePaths {
  root: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  knowledgeBaseFocus?: string;
  knowledgeCurrent: string;
  searchIndexPath: string;
  searchCachePath: string;
  searchEventsPath: string;
  searchErrorsPath: string;
  searchQuerySessionsDir: string;
}

export interface AppConfig {
  configPath: string;
  runtime: { root: string };
  search: {
    embedding_enabled: boolean;
    embedding_provider: EmbeddingProvider;
    embedding_endpoint: string;
    embedding_api_key?: string | null;
    ollama_endpoint: string;
    embedding_model: string;
    embedding_dimensions: number;
    embedding_timeout_seconds: number;
  };
  knowledge_base?: {
    id: string;
    name: string;
    focus: string;
    root: string;
  };
}
