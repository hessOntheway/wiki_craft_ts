# Wiki Craft TS

[English](README.md) | [中文](README.zh-CN.md)

Wiki Craft TS 是一个 TypeScript/Tauri 桌面与 CLI 项目，用来检索已经批准的 Markdown-first 业务知识。项目现在刻意保持很小：一个本地后端服务、一个 GUI、一个 CLI，以及一套能被 coding agent 查询的 approved knowledge 布局。

## 项目做什么

- 在 `.wiki_craft/knowledge_bases/` 下管理多个命名知识库。
- 使用 SQLite FTS5 BM25 和可选 Ollama embedding 检索 approved Markdown。
- 将本地文件直接导入 approved evidence。
- 生成 Codex/Claude/custom skill，让 agent 通过 Wiki Craft CLI 查询知识库。
- 作为单个桌面应用运行：主屏是搜索，侧边栏提供轻量管理。

Wiki Craft 不再负责 LLM 生成知识、candidate staging、diff review 或 code-analysis agent。本地导入被视为用户主动批准的 evidence。

## 目录地图

```text
backend/src/
  cli.ts        npm CLI 命令入口
  server.ts     单一本地 HTTP API
  config.ts     wiki_craft.toml、registry、知识库配置和路径
  runtime.ts    本地导入、skill 导出、Markdown frontmatter helpers
  search.ts     approved vault 检索、SQLite FTS5、Ollama embedding
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

导入本地 approved evidence：

```bash
npm run wiki-craft -- import-local \
  --knowledge-base <knowledge_base_id> \
  --file /path/to/business-context.md \
  --validate
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

生成给外部 AI 使用的代码分析/知识生产 skill：

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

Embedding 默认关闭，所以没有 Ollama 时也可以用 BM25 和 graph metadata 搜索。要启用 hybrid vector search，先设置 `embedding_enabled = true`，确保本地有配置的 Ollama embedding 模型，然后运行：

```bash
npm run wiki-craft -- reindex --knowledge-base <knowledge_base_id>
```

Approved Markdown 是权威来源。Reindex 会扫描所有现有 chunk，并把缺失或过期的 embedding blob 写入 `runtime/search/index.sqlite`。

## 磁盘模型

Approved Markdown 是权威来源：

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

Search 只读取 `knowledge/approved`。检索索引是派生产物，可重建：

```bash
npm run wiki-craft -- reindex --knowledge-base <knowledge_base_id> --lexical-only
```

## 自检

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Node 24 的 `node:sqlite` 目前会打印 experimental warning，这是预期现象。
