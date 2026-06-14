import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CircleAlert,
  Database,
  Download,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-react";

type SkillTarget = "codex" | "claude" | "custom";
type SkillWorkflow = "search" | "author";

interface KnowledgeBaseRecord {
  id: string;
  name: string;
  focus: string;
  root: string;
}

interface KnowledgeBaseListResponse {
  active_id?: string | null;
  knowledge_bases: KnowledgeBaseRecord[];
}

interface SearchResult {
  path: string;
  kind: "index" | "topic" | "source_summary";
  title?: string | null;
  heading?: string | null;
  score: number;
  line_start: number;
  line_end: number;
  snippet: string;
  aliases: string[];
  tags: string[];
  wikilinks: string[];
  source_ids: string[];
  source_urls: string[];
  version_hashes: string[];
  score_breakdown?: {
    lexical?: number;
    vector?: number;
    graph?: number;
  };
  supporting_relations?: Array<{
    subject: string;
    predicate: string;
    object: string;
    evidence_count: number;
  }>;
}

interface SearchResponse {
  query: string;
  top_k: number;
  retrieval_mode: "hybrid" | "bm25" | "graph_hybrid";
  index_status: SearchIndexStatus;
  results: SearchResult[];
}

interface SearchIndexStatus {
  indexed_chunks: number;
  embedded_chunks: number;
  stale_vectors: number;
  graph_edges: number;
  embedding_signature?: string | null;
  warning?: string | null;
}

interface ImportLocalOutcome {
  source_id: string;
  source_url: string;
  summary_path: string;
  content_hash: string;
  changed: boolean;
  message: string;
  warnings: string[];
}

interface SkillCreateOutcome {
  skill_name: string;
  skill_path: string;
  message: string;
  workflow: SkillWorkflow;
}

export function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseRecord[]>([]);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [searchResponse, setSearchResponse] = useState<SearchResponse | null>(null);
  const [searched, setSearched] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  const [newName, setNewName] = useState("");
  const [newFocus, setNewFocus] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [importPath, setImportPath] = useState("");
  const [skillTarget, setSkillTarget] = useState<SkillTarget>("codex");
  const [skillWorkflow, setSkillWorkflow] = useState<SkillWorkflow>("search");
  const [skillDestination, setSkillDestination] = useState("");

  const selected = useMemo(
    () => knowledgeBases.find((knowledgeBase) => knowledgeBase.id === knowledgeBaseId) || null,
    [knowledgeBaseId, knowledgeBases],
  );

  useEffect(() => {
    void (async () => {
      try {
        const base = await resolveApiBaseUrl();
        setApiBaseUrl(base);
        await waitForHealth(`${base}/api/health`);
        await refreshKnowledgeBases(base);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const refreshKnowledgeBases = async (base = apiBaseUrl, preferredId = knowledgeBaseId) => {
    const list = await requestJson<KnowledgeBaseListResponse>(`${base}/api/knowledge-bases`);
    setKnowledgeBases(list.knowledge_bases);
    const nextId = preferredId && list.knowledge_bases.some((kb) => kb.id === preferredId)
      ? preferredId
      : list.active_id || list.knowledge_bases[0]?.id || "";
    setKnowledgeBaseId(nextId);
    return nextId;
  };

  const withAction = async (action: () => Promise<string | void>) => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const nextMessage = await action();
      if (nextMessage) setMessage(nextMessage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const createKnowledgeBase = async () => withAction(async () => {
    const response = await requestJson<{ knowledge_base: KnowledgeBaseRecord }>(`${apiBaseUrl}/api/knowledge-bases`, {
      method: "POST",
      body: { name: newName.trim(), focus: newFocus.trim() },
    });
    setNewName("");
    setNewFocus("");
    await refreshKnowledgeBases(apiBaseUrl, response.knowledge_base.id);
    return `Created ${response.knowledge_base.name}`;
  });

  const deleteKnowledgeBase = async () => withAction(async () => {
    if (!selected) return;
    await requestJson<KnowledgeBaseListResponse>(`${apiBaseUrl}/api/knowledge-bases/${encodeURIComponent(selected.id)}`, {
      method: "DELETE",
      body: { confirmation_name: deleteConfirmation },
    });
    setDeleteConfirmation("");
    setSearchResponse(null);
    setSearched(false);
    await refreshKnowledgeBases(apiBaseUrl, "");
    return `Deleted ${selected.name}`;
  });

  const runSearch = async () => {
    const trimmed = query.trim();
    if (!knowledgeBaseId || !trimmed) {
      setError("Select a knowledge base and enter a query.");
      return;
    }
    setSearchLoading(true);
    setError("");
    setMessage("");
    setSearched(true);
    try {
      const params = new URLSearchParams({
        knowledge_base: knowledgeBaseId,
        query: trimmed,
        top_k: String(Math.min(20, Math.max(1, Math.round(topK || 5)))),
      });
      setSearchResponse(await requestJson<SearchResponse>(`${apiBaseUrl}/api/search?${params}`));
    } catch (reason) {
      setSearchResponse(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSearchLoading(false);
    }
  };

  const chooseImportFile = async () => {
    if (!window.__TAURI_INTERNALS__) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({ multiple: false, directory: false });
    if (typeof chosen === "string") setImportPath(chosen);
  };

  const importLocal = async () => withAction(async () => {
    if (!selected) return;
    const outcome = await requestJson<ImportLocalOutcome>(`${apiBaseUrl}/api/knowledge-bases/${encodeURIComponent(selected.id)}/import-local`, {
      method: "POST",
      body: { path: importPath.trim(), validate: true },
    });
    setImportPath("");
    setSearchResponse(null);
    setSearched(false);
    const warningText = outcome.warnings.length ? ` (${outcome.warnings.length} warning${outcome.warnings.length === 1 ? "" : "s"})` : "";
    return `${outcome.changed ? "Imported" : "Already current"}: ${outcome.summary_path}${warningText}`;
  });

  const createSkill = async () => withAction(async () => {
    if (!selected) return;
    const outcome = await requestJson<SkillCreateOutcome>(`${apiBaseUrl}/api/knowledge-bases/${encodeURIComponent(selected.id)}/skill`, {
      method: "POST",
      body: {
        target: skillTarget,
        workflow: skillWorkflow,
        destination_path: skillTarget === "custom" ? skillDestination.trim() : skillDestination.trim() || undefined,
      },
    });
    return `${outcome.workflow} skill created: ${outcome.skill_path}`;
  });

  return (
    <div className="app-shell search-app-shell">
      <aside className="sidebar">
        <header className="brand">
          <p className="eyebrow">Wiki Craft</p>
          <h1>Search</h1>
        </header>

        <section className="knowledge-base-panel">
          <div className="knowledge-base-head">
            <span className="section-title">Knowledge Base</span>
            <button className="icon-button" type="button" onClick={() => void refreshKnowledgeBases()} disabled={loading} title="Refresh">
              <RefreshCw size={16} />
            </button>
          </div>
          <label className="knowledge-base-select">
            <Database size={16} />
            <select value={knowledgeBaseId} onChange={(event) => setKnowledgeBaseId(event.target.value)} disabled={loading || knowledgeBases.length === 0}>
              {knowledgeBases.map((knowledgeBase) => (
                <option value={knowledgeBase.id} key={knowledgeBase.id}>{knowledgeBase.name}</option>
              ))}
            </select>
          </label>
          <p className="knowledge-base-focus">{selected?.focus || "Create or select an approved knowledge vault."}</p>
        </section>

        <section className="knowledge-base-panel">
          <span className="section-title">Create</span>
          <form className="knowledge-base-form" onSubmit={(event) => { event.preventDefault(); void createKnowledgeBase(); }}>
            <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Name" />
            <textarea value={newFocus} onChange={(event) => setNewFocus(event.target.value)} placeholder="Focus" rows={3} />
            <button className="primary-button" type="submit" disabled={loading || !newName.trim() || !newFocus.trim()}>
              <Plus size={16} />
              Create
            </button>
          </form>
        </section>

        <section className="knowledge-base-panel">
          <span className="section-title">Tools</span>
          <form className="knowledge-base-form" onSubmit={(event) => { event.preventDefault(); void importLocal(); }}>
            <div className="inline-field">
              <input value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder="Local file path" />
              {Boolean(window.__TAURI_INTERNALS__) && (
                <button className="icon-button" type="button" onClick={() => void chooseImportFile()} title="Choose file">
                  <FolderOpen size={16} />
                </button>
              )}
            </div>
            <button className="secondary-button" type="submit" disabled={loading || !selected || !importPath.trim()}>
              <Download size={16} />
              Import
            </button>
          </form>

          <form className="knowledge-base-form" onSubmit={(event) => { event.preventDefault(); void createSkill(); }}>
            <select value={skillTarget} onChange={(event) => setSkillTarget(event.target.value as SkillTarget)}>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="custom">Custom</option>
            </select>
            <select value={skillWorkflow} onChange={(event) => setSkillWorkflow(event.target.value as SkillWorkflow)}>
              <option value="search">Search</option>
              <option value="author">Author</option>
            </select>
            <input value={skillDestination} onChange={(event) => setSkillDestination(event.target.value)} placeholder={skillTarget === "custom" ? "Destination path" : "Optional destination path"} />
            <button className="secondary-button" type="submit" disabled={loading || !selected || (skillTarget === "custom" && !skillDestination.trim())}>
              <Save size={16} />
              Skill
            </button>
          </form>
        </section>

        {selected && (
          <section className="knowledge-base-panel danger-zone">
            <span className="section-title">Delete</span>
            <input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} placeholder={selected.name} />
            <button className="secondary-button danger" type="button" onClick={() => void deleteKnowledgeBase()} disabled={loading || deleteConfirmation !== selected.name}>
              <Trash2 size={16} />
              Delete
            </button>
          </section>
        )}
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <p className="eyebrow">{selected?.name || "No Knowledge Base"}</p>
            <h2>Approved Knowledge Search</h2>
          </div>
        </header>

        <section className="search-surface">
          <form className="search-form" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
            <label className="search-field">
              <span>Query</span>
              <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search approved knowledge" />
            </label>
            <label className="top-k-field">
              <span>Top K</span>
              <input type="number" min={1} max={20} value={topK} onChange={(event) => setTopK(Number(event.target.value))} />
            </label>
            <button className="primary-button" type="submit" disabled={searchLoading || loading || !knowledgeBaseId}>
              {searchLoading ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}
              Search
            </button>
          </form>

          {error && <div className="notice error"><CircleAlert size={17} /><span>{error}</span></div>}
          {message && <div className="notice success"><Check size={17} /><span>{message}</span></div>}
          {searchResponse && <SearchIndexSummary response={searchResponse} />}

          <div className="search-results">
            {searchResponse?.results.map((result, index) => <SearchResultCard result={result} index={index} key={`${result.path}-${result.line_start}`} />)}
            {!searchLoading && searched && searchResponse?.results.length === 0 && <section className="empty-state"><Search size={28} /><p>No approved knowledge matched this query.</p></section>}
            {!searchLoading && !searched && <section className="empty-state"><Search size={28} /><p>Choose a knowledge base and search its approved vault.</p></section>}
          </div>
        </section>
      </main>
    </div>
  );
}

function SearchIndexSummary({ response }: { response: SearchResponse }) {
  return (
    <>
      <div className="search-index-status">
        <span className={`retrieval-mode ${response.retrieval_mode}`}>{retrievalModeLabel(response.retrieval_mode)}</span>
        <span>{response.index_status.embedded_chunks}/{response.index_status.indexed_chunks} vectors ready</span>
        <span>{response.index_status.graph_edges} graph edges</span>
      </div>
      {response.index_status.warning && <div className="notice warning"><CircleAlert size={17} /><span>{response.index_status.warning}</span></div>}
    </>
  );
}

function SearchResultCard({ result, index }: { result: SearchResult; index: number }) {
  const breakdown = scoreBreakdown(result);
  return (
    <article className="search-result-card">
      <header>
        <div>
          <span className="result-rank">{index + 1}</span>
          <h3>{result.title || result.heading || result.path}</h3>
        </div>
        <span className={`result-kind ${result.kind}`}>{result.kind.replace("_", " ")}</span>
      </header>
      <p className="result-meta">Score {result.score.toFixed(2)} | {result.path}:{result.line_start}-{result.line_end}</p>
      {breakdown.length > 0 && (
        <div className="score-breakdown">
          {breakdown.map((item) => <span key={item.label}>{item.label} {item.value.toFixed(4)}</span>)}
        </div>
      )}
      {Boolean(result.supporting_relations?.length) && (
        <div className="relation-list" aria-label="Related graph evidence">
          {result.supporting_relations!.map((relation) => (
            <span className="relation-chip" key={`${relation.subject}-${relation.predicate}-${relation.object}`}>
              {relation.subject} -&gt; {relation.predicate} -&gt; {relation.object}
            </span>
          ))}
        </div>
      )}
      <pre className="result-snippet">{result.snippet}</pre>
    </article>
  );
}

function retrievalModeLabel(mode: SearchResponse["retrieval_mode"]) {
  if (mode === "graph_hybrid") return "Graph Hybrid";
  return mode === "hybrid" ? "Hybrid" : "BM25";
}

function scoreBreakdown(result: SearchResult): Array<{ label: string; value: number }> {
  const source = result.score_breakdown;
  if (!source) return [];
  return [
    source.lexical ? { label: "BM25", value: source.lexical } : null,
    source.vector ? { label: "Vector", value: source.vector } : null,
    source.graph ? { label: "Graph", value: source.graph } : null,
  ].filter((item): item is { label: string; value: number } => Boolean(item));
}

async function requestJson<T>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body as T;
}

async function resolveApiBaseUrl() {
  const envBase = import.meta.env.VITE_API_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  if (window.__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string>("get_api_base_url")).replace(/\/$/, "");
  }
  return "";
}

async function waitForHealth(url: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const health = response.ok ? await response.json() as { service?: string } : null;
      if (health?.service === "app") return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error("Local Wiki Craft API did not become ready");
}
