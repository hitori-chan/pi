# Fork notes

Fork of [earendil-works/pi](https://github.com/earendil-works/pi), maintained for local use only
(no upstream PR). All changes are in `packages/coding-agent`.

Branches: `compaction-fix-0.84.4` (installed here) = the changes on `b79e4cc83`
(“Release v0.84.4”, the exact published base); `compaction-fix` = the same changes on
current `main`.

## Why

Field forensics on a local reasoning model (`llama-cpp/qwen3.8-27b`, thinking `xhigh`,
`maxTokens 32768`, `contextWindow 131072`) showed auto-compaction hard-failing in a
retry flap, and context crossing the window mid-run. Three root causes, all in pi core:

1. **Summarizer budget vs. thinking.** The summarization request runs at the session's
   thinking level (up to `xhigh`), but its output cap is `0.8 × reserveTokens` — with the
   default 16,384 reserve that is 13,107, shared by reasoning tokens *and* summary text.
   On a long context the thinking tail alone can exceed the cap → `stopReason: "length"`.
2. **0.84.4 hard-fails on `length`.** Pre-0.84.4 the same stop silently accepted a
   truncated summary. 0.84.4's `getSummarizationFailure` rejects it, the compaction entry
   is not persisted, and the next turn re-triggers — an ~8-minute flap per crossing.
3. **No mid-run convergence.** Compaction only runs on settled states (run boundaries /
   overflow recovery). A long tool loop crossing the compaction line mid-run keeps
   growing to the window, where the provider clamps `max_tokens` and every response
   truncates (`stopReason: "length"`, `output < maxTokens`).

Note: "Context overflow" is a client-side inference (`isRecoverableLength`); the server
clamps `max_tokens` silently. Server logs stay clean by design.

## Changes

### `src/core/compaction/compaction.ts`

- **`CompactionSettings.thinkingLevel`** (`"minimal" | "low" | "medium" | "high" |
  "xhigh" | "off" | "inherit"`, default **`"off"`**). The summarization pass now runs at
  this level instead of inheriting the session level. `"inherit"` restores the 0.84.4
  behavior. This is the root fix: a thinking-off summary is a few k tokens and fits any
  sane cap.
- **Cap formula**: summary cap is now `min(0.8 × (reserveTokens + keepRecentTokens),
  model.maxTokens)`. The old `0.8 × reserveTokens` ignored that the summarization input
  excludes the kept tail (`keepRecentTokens`, default 20,000), i.e. the provider actually
  has `reserveTokens + keepRecentTokens` of output headroom at the compaction line.
  Turn-prefix cap follows: `0.5 × (reserveTokens + keepRecentTokens)`.
- **Length retry**: a length-limited summary is retried once at `model.maxTokens` before
  failing — matching pi-ai's own rationale that reasoning and answer share `max_tokens`.

### `src/core/settings-manager.ts`

- New `compaction.thinkingLevel` (default `"off"`) and `compaction.midRunReserveTokens`
  (default 16,384) settings, surfaced in `getCompactionSettings()`.

### `src/core/compaction/midrun.ts` + `src/core/agent-session.ts`

Mid-run convergence steering, ported from the external `midrun-autocompact` extension
into core (invisible custom messages, system-note style):

- When a still-running tool loop crosses the steer line — `contextWindow −
  max(midRunReserveTokens, reserveTokens)` — an invisible note asks the model to
  converge in-flight work and end the turn, so native compaction runs on a settled state.
- Only `toolUse` stops are steered; at most one nudge per 8,192-token rise (max two per
  run); `stop` never triggers (a finished turn is not restarted — resume only follows a
  mid-run compaction).
- After a mid-run compaction, when the steered run settles cleanly, one invisible resume
  note continues the work from the summary.
- Diagnostics are appended as `customType: "midrun-autocompact"` session entries
  (phases: `steer`, `compacted`, `resuming`, `settled`, `resume-skipped`,
  `resume-cancelled`) — visible in the session file, never in the TUI.

## Settings for the model above

```json
"compaction": { "reserveTokens": 40960 }
```

- Compaction line: 131,072 − 40,960 = 90,112 (68.75%) — below the 75% clamp zone
  (window − maxTokens = 98,304) with an 8,192-token buffer.
- Summary cap: min(0.8 × 60,960, 32,768) = 32,768 (model ceiling).
- Summarizer thinking: `off` (default) → summary ≈ 5–7k tokens.
- `midRunReserveTokens`: default 16,384 → steer line coincides with the compaction line.

## Test findings (upstream edge cases, left as-is)

- Mid-run compaction no-ops when the newest context ends in a single tool result larger
  than `keepRecentTokens` (the cut point snaps to the first valid cut point; if that
  leaves nothing to summarize, `prepareCompaction` returns undefined). Boundary
  compaction after the model's stop message still works. Rare with the 20k default.
- Threshold compaction on a run that ended in `stop` does not continue the run; it
  compacts and ends. The user's next prompt starts on the compacted context.
- `estimateContextTokens` on the steer hook path uses message estimates; faux/test
  providers report usage as ~chars/4 with no cache doubling.

## Tests

`test/compaction-summary-reasoning.test.ts` (thinking knob + cap + length retry),
`test/suite/agent-session-midrun.test.ts` (steer → mid-run compaction → invisible
resume; silence below the line), `test/suite/regressions/7048-…` updated for the retry.
Full suite: 2,106 passed, 0 failed.

## Install (this machine)

The global install is a full package (CLI runs `dist/bundle`, extensions import
`dist/index.js`), and its `node_modules` are publish-bundled — so replace only
`package.json` + `dist`, keeping the original `node_modules`:

```sh
P=~/.local/lib/node_modules/@earendil-works/pi-coding-agent
cp -a "$P" "$P.orig-0.84.4"          # one-time backup
cd <this repo>/packages/coding-agent
rsync -a --delete --exclude node_modules ./ "$P/"   # after: npm run build
```

The external `midrun-autocompact` extension was removed from `~/.pi/agent/settings.json`
`packages` (now vestigial; lives on in `github.com/hitori-chan/pi-extensions` as the
pre-fork history of this code).
