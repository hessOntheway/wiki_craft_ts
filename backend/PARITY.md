# Backend Notes

Wiki Craft TS is now a search-first TypeScript backend rather than a Rust parity port.

## Supported Surface

- `init`
- `knowledge-base list|create|activate|delete`
- `import-local --knowledge-base <id> --file <path>`
- `search --knowledge-base <id> --query <query> [--top-k <n>] [--json]`
- `reindex --knowledge-base <id> [--lexical-only]`
- `skill create --knowledge-base <id> --target codex|claude|custom [--destination-path <dir>]`
- `service [--port 9900]`

## Removed Surface

- LLM source ingest
- Candidate staging, approval, diff, merge, and reject
- Metrics snapshots and Prometheus output
- Code-analysis sessions
- Separate maintenance/search services

## Verification

```bash
npm run build:backend
cargo check --manifest-path src-tauri/Cargo.toml
```
