# Contributing to Toknado 🌪️

Thanks for wanting to help! Toknado is intentionally small — please keep it that way.

## Ground rules

1. **Zero runtime dependencies.** The whole point is `npx toknado` with nothing to trust but Node. PRs that add dependencies need a very good reason.
2. **Local-first, always.** No telemetry, no network calls beyond `127.0.0.1`, no persisted state. Anything that phones home will be rejected.
3. **Logs are read-only.** Never write into `~/.claude` or `~/.codex`.
4. **Tokens are the product; dollars are a footnote.** Cost panels must stay clearly labeled as hypothetical.

## Dev setup

```bash
git clone https://github.com/kaantufan/toknado
cd toknado
node bin/toknado.js          # that's it — no install step
```

## Project layout

| Path | What lives there |
|---|---|
| `bin/toknado.js` | CLI entry, arg parsing, browser open |
| `src/parse/claude.js` | Claude Code JSONL parser (dedupe by `message.id + requestId`) |
| `src/parse/codex.js` | Codex rollout parser — **read the header comment before touching it**; fork-copied history dedup is the load-bearing wall |
| `src/aggregate.js` | All bucketing/percentage math (pure functions) |
| `src/pricing.js` | List-price table for the what-if panel |
| `src/export.js` | JSON / CSV / Markdown formatters |
| `src/server.js` | Zero-dep HTTP server |
| `web/index.html` | The entire dashboard — vanilla JS, hand-rolled SVG charts |

## Adding support for another agent CLI

The most valuable contribution! Write a parser in `src/parse/<agent>.js` that emits the unified event shape:

```js
{ source, ts, sessionId, project, model, mode,
  input, output, cacheRead, cacheWrite }
```

- `input` is **fresh (uncached)** input — normalize if the CLI reports cached-inclusive input.
- Watch for duplicated history: several CLIs copy parent events into forked/resumed session files. Verify your totals against a known-good reference before trusting them.
- Wire it up in `bin/toknado.js` and add a source color in `web/index.html`.

## Verifying parser changes

Token totals must be defensible. Before opening a PR that touches a parser:

1. Run against your real logs and sanity-check the total (per-call average, output share).
2. Check dedup: the same logical API call must never count twice across forked/copied files.
3. Confirm date bucketing is **local-time** end to end.

## Pricing updates

`src/pricing.js` holds USD per-Mtok list prices, prefix-matched (longest wins). Include a source link in the PR description for any price change.

## Style

- ESM, Node ≥ 18, no build step.
- Comments explain *why*, not *what* — especially in the parsers.
- UI text is English; keep it short.
