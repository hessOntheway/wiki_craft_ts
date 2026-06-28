# Wiki Craft TS

[English](README.md) | [中文](README.zh-CN.md)

Wiki Craft TS 是一个 TypeScript/Tauri 桌面与 CLI 项目，用来检索 Markdown-first 业务知识。项目现在刻意保持很小：一个本地后端服务、一个 GUI、一个 CLI，以及一套能被 coding agent 查询的 knowledge 布局。

## 项目做什么

- 在 `.wiki_craft/knowledge_bases/` 下管理多个命名知识库。
- 使用 SQLite FTS5 BM25、graph metadata 和可选 embedding 检索 knowledge Markdown。
- 生成 authoring skill，让 agent 直接维护所选知识库的 knowledge 文件。
- 生成 Codex/Claude/custom skill，让 agent 通过 Wiki Craft CLI 查询知识库。
- 作为单个桌面应用运行：主屏是搜索，侧边栏提供轻量管理。

Wiki Craft 不再负责 candidate staging 或单独审批流。所选知识库 `knowledge/` 目录下的 Markdown 是事实源。

## 目录地图

```text
backend/src/
  cli.ts        npm CLI 命令入口
  server.ts     单一本地 HTTP API
  config.ts     wiki_craft.toml、registry、知识库配置和路径
  runtime.ts    skill 导出、Markdown frontmatter helpers
  search.ts     knowledge vault 检索、SQLite FTS5、可选 embedding
  types.ts      共享公开契约
  util.ts       文件系统、hash、路径、TOML、Markdown 小工具

frontend/src/
  App.tsx       搜索 + 轻管理的统一 GUI
  main.tsx      单 React 入口
  styles.css    共享样式

src-tauri/      单一 Rust Tauri 壳
backend/test/   后端和 CLI 测试
docs/knowledge/ 面向 agent 的 code model
```

## 快速开始

```bash
npm run wiki-craft -- init
npm run wiki-craft -- knowledge-base create \
  --name "AI Review Knowledge" \
  --focus "Business context for AI code review"
```

检索：

```bash
npm run wiki-craft -- search \
  --knowledge-base <knowledge_base_id> \
  --query "review risk for payment changes" \
  --top-k 5 \
  --json
```

生成 agent skill：

```bash
npm run wiki-craft -- skill create \
  --knowledge-base <knowledge_base_id> \
  --target codex \
  --workflow search
```

生成给外部 AI 使用的代码分析/知识生产 skill，让它直接写入 knowledge 文件并 reindex：

```bash
npm run wiki-craft -- skill create \
  --knowledge-base <knowledge_base_id> \
  --target codex \
  --workflow author
```

## 服务与 GUI

启动本地 API：

```bash
npm run wiki-craft -- service --port 9900
```

启动前端或桌面应用：

```bash
npm --prefix frontend install
npm run dev
npm run tauri:dev
```

设置 `WIKI_CRAFT_CONFIG=/path/to/wiki_craft.toml` 可切换 workspace。设置 `WIKI_CRAFT_API_URL` 可让桌面应用连接已有本地服务。

## Embedding

Embedding 默认关闭，所以没有本地模型服务时也可以用 BM25 和 graph metadata 搜索。要启用 hybrid vector search，先选择 provider，然后运行：

```toml
[search]
embedding_provider = "ollama"
ollama_endpoint = "http://127.0.0.1:11434"
embedding_model = "bge-m3"
embedding_dimensions = 1024
```

如果使用托管或自建的 OpenAI-compatible embedding API：

```toml
[search]
embedding_provider = "openai_compatible"
embedding_endpoint = "https://example.com/openai/v1"
embedding_api_key = "..."
embedding_model = "embedding-v1"
embedding_dimensions = 1024
```

旧配置 `embedding_enabled = true` 仍然兼容：当没有设置 `embedding_provider` 时，它会启用 Ollama provider。

```bash
npm run wiki-craft -- reindex --knowledge-base <knowledge_base_id>
```

Knowledge Markdown 是权威来源。Reindex 会扫描所有现有 chunk，写入 chunk 级 add/update/delete event，并把缺失或过期的 embedding blob 写入 `runtime/search/index.sqlite`。

## 磁盘模型

Knowledge Markdown 是权威来源：

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

Search 只读取 `knowledge`。检索索引和 event log 是派生产物，可重建：

```bash
npm run wiki-craft -- reindex --knowledge-base <knowledge_base_id> --lexical-only
```

## 自检

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Node 24 的 `node:sqlite` 目前会打印 experimental warning，这是预期现象。
