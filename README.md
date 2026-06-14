# Wiki Craft TS

[English](README.md) | [中文](README.zh-CN.md)

Wiki Craft TS is a TypeScript/Tauri desktop and CLI project for searching approved, Markdown-first business knowledge. It is intentionally small: one local backend service, one GUI, one CLI, and one approved knowledge layout that coding agents can query before answering review or design questions.

## What It Does

- Keeps multiple named knowledge bases under `.wiki_craft/knowledge_bases/`.
- Searches approved Markdown with SQLite FTS5 BM25 and optional Ollama embeddings.
- Imports local files directly into approved evidence.
- Generates Codex/Claude/custom skills that call the Wiki Craft CLI search command.
- Runs as a single desktop app with search as the primary screen and lightweight management in the sidebar.

Wiki Craft does not generate knowledge with an LLM, stage candidates, review diffs, or run code-analysis agents. Local import is treated as a user-approved evidence action.

## Project Map

```text
backend/src/
  cli.ts        npm CLI command entrypoint
  server.ts     single local HTTP API
  config.ts     wiki_craft.toml, registry, knowledge-base config, paths
  runtime.ts    local import, skill export, Markdown frontmatter helpers
  search.ts     approved-vault search, SQLite FTS5, Ollama embeddings
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

Import a local approved evidence file:

```bash
npm run wiki-craft -- import-local \
  --knowledge-base <knowledge_base_id> \
  --file /path/to/business-context.md \
  --validate
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

Generate a code-analysis authoring skill for external AI tools that should produce Wiki Craft topic Markdown:

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

Embeddings are disabled by default, so search works with BM25 and graph metadata without requiring Ollama. To enable hybrid vector search, set `embedding_enabled = true`, make the configured Ollama embedding model available, then run:

```bash
npm run wiki-craft -- reindex --knowledge-base <knowledge_base_id>
```

Existing approved Markdown is the source of truth. Reindexing scans all current chunks and stores missing or stale embedding blobs in `runtime/search/index.sqlite`.

## Disk Model

Approved Markdown is the source of truth:

```text
.wiki_craft/
  knowledge_bases/
    registry.json
    {id}/
      knowledge_base.toml
      knowledge/
        approved/
          index.md
          topics/*.md
          evidence/source_summaries/*.md
          evidence/sources/manifest.json
      runtime/
        search/index.sqlite
        search/index.json
```

Search reads only `knowledge/approved`. The search index is derived and can be rebuilt:

```bash
npm run wiki-craft -- reindex --knowledge-base <knowledge_base_id> --lexical-only
```

## Self Check

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Node 24 currently prints an experimental warning for `node:sqlite`; that warning is expected.
