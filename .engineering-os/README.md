# `.engineering-os/` — Shared Memory (product repo)

This directory holds the Engineering OS shared agent memory. It is **committed to git**. Every teammate who clones the repo and runs `git pull` receives the full state of every prior run.

Do NOT add this directory to `.gitignore`. Do NOT remove `.gitattributes`.

## Layout
- `memory/agents/` — per-agent append-only journals
- `memory/features/` — per-feature append-only journals
- `state/` — active.json (last-write-wins), registry.json (append-only)
- `decision-log/` — YYYY/MM/YYYY-MM-DD.jsonl (immutable line-per-event stream)
- `runs/` — per-run timestamped artifact bundles (no collisions possible)
- `artifacts/` — optional per-req cross-links / large artifacts
- `index/` — **derived** semantic vector index (`memory.db`). Gitignored + rebuildable from the above via `/reindex`. NOT a source of truth.

The plugin agents read/write here automatically. You typically don't touch these files by hand. Use `/status` and `/recall <feat-slug>` to inspect state.
