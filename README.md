# Wiki Craft TS

[English](README.md) | [中文](README.zh-CN.md)

Wiki Craft TS is a TypeScript/Tauri desktop and CLI project for searching Markdown-first business knowledge. It is intentionally small: one local backend service, one GUI, one CLI, and one knowledge layout that coding agents can query before answering review or design questions.

## What It Does

- Keeps multiple named knowledge bases under `.wiki_craft/knowledge_bases/`.
- Searches knowledge Markdown with SQLite FTS5 BM25, graph metadata, and optional embeddings.
- Generates authoring skills that write knowledge files directly under a selected knowledge base.
- Generates Codex/Claude/custom skills that call the Wiki Craft CLI search command.
- Runs as a single desktop app with search as the primary screen and lightweight management in the sidebar.

Wiki Craft does not stage candidates or run a separate approval flow. Knowledge files under a selected knowledge base are the source of truth.

## Project Map

```text
backend/src/
  cli.ts        npm CLI command entrypoint
  server.ts     single local HTTP API
  config.ts     wiki_craft.toml, registry, knowledge-base config, paths
  runtime.ts    skill export and Markdown frontmatter helpers
  search.ts     knowledge-vault search, SQLite FTS5, optional embeddings
  types.ts      shared public contracts
  util.ts       filesystem, hashing, path, TOML, and Markdown helpers

frontend/src/
  App.tsx       unified search + lightweight management GUI
  main.tsx      single React entrypoint
  styles.css    shared styles

src-tauri/      single thin Rust Tauri shell
backend/test/   backend and CLI tests
docs/knowledge/ code model for agents
```

## Quick Start

```bash
npm run wiki-craft -- init
npm run wiki-craft -- knowledge-base create \
  --name "AI Review Knowledge" \
  --focus "Business context for AI code review"
```

Search it:

```bash
npm run wiki-craft -- search \
  --knowledge-base <knowledge_base_id> \
  --query "review risk for payment changes" \
  --top-k 5 \
  --json
```

Generate an agent skill:

```bash
npm run wiki-craft -- skill create \
  --knowledge-base <knowledge_base_id> \
  --target codex \
  --workflow search
```

Generate a code-analysis authoring skill for external AI tools that should write Wiki Craft topic Markdown and reindex the knowledge base:

```bash
npm run wiki-craft -- skill create \
  --knowledge-base <knowledge_base_id> \
  --target codex \
  --workflow author
```

## Service And GUI

Start the local API:

```bash
npm run wiki-craft -- service --port 9900
```

Run the frontend or desktop app:

```bash
npm --prefix frontend install
npm run dev
npm run tauri:dev
```

Set `WIKI_CRAFT_CONFIG=/path/to/wiki_craft.toml` to switch workspaces. Set `WIKI_CRAFT_API_URL` to point the desktop app at an existing local service.

## Embeddings

Embeddings are disabled by default, so search works with BM25 and graph metadata without requiring a local model service. To enable hybrid vector search, choose a provider and then run:

```toml
[search]
embedding_provider = "ollama"
ollama_endpoint = "http://127.0.0.1:11434"
embedding_model = "bge-m3"
embedding_dimensions = 1024
```

For hosted or self-hosted OpenAI-compatible embedding APIs:

```toml
[search]
embedding_provider = "openai_compatible"
embedding_endpoint = "https://example.com/openai/v1"
embedding_api_key = "..."
embedding_model = "embedding-v1"
embedding_dimensions = 1024
```

The legacy `embedding_enabled = true` setting still enables the Ollama provider when `embedding_provider` is omitted.

```bash
npm run wiki-craft -- reindex --knowledge-base <knowledge_base_id>
```

Existing knowledge Markdown is the source of truth. Reindexing scans all current chunks, writes chunk-level add/update/delete events, and stores missing or stale embedding blobs in `runtime/search/index.sqlite`.

## Disk Model

Knowledge Markdown is the source of truth:

```text
.wiki_craft/
  knowledge_bases/
    registry.json
    {id}/
      knowledge/
        index.md
        *.md
      runtime/
        search/index.sqlite
        search/index.json
        search/events.jsonl
        search/errors.jsonl
```

Search reads only `knowledge`. The search index is derived and can be rebuilt:

```bash
npm run wiki-craft -- reindex --knowledge-base <knowledge_base_id> --lexical-only
```

## Self Check

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Node 24 currently prints an experimental warning for `node:sqlite`; that warning is expected.
