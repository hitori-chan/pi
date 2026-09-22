# Fork notes

Fork of [earendil-works/pi](https://github.com/earendil-works/pi) at `v0.87.0` (branch
`compaction-fix`), maintained for local use only (no upstream PR). All changes are in
`packages/coding-agent`.

## Why

Field forensics on a local reasoning model (`llama-cpp/qwen3.8-27b`, thinking `xhigh`,
`maxTokens 32768`, `contextWindow 131072`) showed auto-compaction hard-failing in a
retry flap, and context crossing the window mid-run. Three root causes, all in pi core:

1. **Summarizer budget vs. thinking.** The summarization request runs at the session's
   thinking level (up to `xhigh`), but its output cap is `0.8 × reserveTokens` — with the
   default 16,384 reserve that is 13,107, shared by reasoning tokens *and* summary text.
   On a long context the thinking tail alone can exceed the cap → `stopReason: "length"`.
2. **0.84.4+ hard-fails on `length`.** Pre-0.84.4 the same stop silently accepted a
   truncated summary. `getSummarizationFailure` (introduced in 0.84.4, unchanged in
   v0.87.0) rejects it, the compaction entry is not persisted, and the next turn
   re-triggers — an ~8-minute flap per crossing.
3. **No mid-run convergence.** Compaction only runs on settled states (run boundaries /
   overflow recovery). A long tool loop crossing the compaction line mid-run keeps
   growing to the window, where the provider clamps `max_tokens` and every response
   truncates (`stopReason: "length"`, `output < maxTokens`).

Note: "Context overflow" is a client-side inference (`isRecoverableLength`); the server
clamps `max_tokens` silently. Server logs stay clean by design.

**v0.87.0 patch review** (upstream `v0.85.1..v0.87.0`): all three fixes are still
needed — upstream changed neither the summarizer's thinking level nor the cap formula,
and still has no mid-run steering (compaction remains boundary/overflow-only). v0.87.0
rewrote compaction preparation on top of the new canonical session projection
(`buildSessionProjection`): cut points, token estimates, and message selection now
operate on projected entries so context edits and omitted recovery attempts are handled
canonically. The fork's `compaction.ts` changes (cap formula, length retry) sit in
functions upstream did not touch and applied cleanly; the session wiring needed two
adapts — the steer hook now estimates on `projection.messages` (the actual request
content) with the new `estimateProjectedContextTokens`, and the run-end drain block
follows the reshaped `_handlePostAgentRun` (new `_checkCompaction(message, true,
toolResults)` signature). `getCompactionSettings()` stays in the upstream 3-field shape
so extension payloads do not diverge.

## Changes

### `src/core/compaction/compaction.ts`

- **Cap formula**: summary cap is now `min(0.8 × (reserveTokens + keepRecentTokens),
  model.maxTokens)`. The old `0.8 × reserveTokens` ignored that the summarization input
  excludes the kept tail (`keepRecentTokens`, default 20,000), i.e. the provider actually
  has `reserveTokens + keepRecentTokens` of output headroom at the compaction line.
  Turn-prefix cap follows: `0.5 × (reserveTokens + keepRecentTokens)`.
- **Length retry**: a length-limited summary is retried once at `model.maxTokens` before
  failing — matching pi-ai's own rationale that reasoning and answer share `max_tokens`.
- The type surface stays identical to upstream: `CompactionSettings` and
  `CompactionPreparation` keep the 3-field shape; the summarizer's thinking level is not
  part of it (it is resolved in the session, below).

### `src/core/settings-manager.ts`

- New `compaction.thinkingLevel` (default `"off"`, `"inherit"` = session level),
  `compaction.midRunReserveTokens` (default 16,384), and `compaction.evict` (default
  `true`) settings, surfaced as `getCompactionThinkingLevel()` /
  `getCompactionMidRunReserveTokens()` / `getCompactionEvict()`.
  `getCompactionSettings()` keeps the upstream shape (enabled + resolved token budgets,
  including per-model overrides) so `session_before_compact` payloads do not diverge.

### `src/core/agent-session.ts`

- `_resolveCompactionThinkingLevel()`: the setting wins; `"inherit"` falls back to the
  session level. Resolved once per compaction and passed to the built-in summarizer
  through the existing `thinkingLevel` argument (no upstream signature change). This is
  the root fix for cause 1: a thinking-off summary is a few k tokens and fits any sane
  cap.
- Mid-run convergence steering (below), wired through the
  `prepareNextTurnWithContext` hook. As of v0.87.0 the hook steers on the projected
  messages and the run-end drain block keeps the fork's resume/cancel logic on top of
  upstream's reshaped post-run handling.

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

### `src/core/compaction/evict.ts` + `src/core/agent-session.ts`

Stale tool-result eviction, built on v0.87.0's append-only context edits
(`sessionManager.appendContextEdit(targetId, null)` = omission; raw history, usage
records, and the UI transcript untouched). The external `context-evict` extension was
dissolved into this module (the pi-extensions repo no longer exists locally; the
GitHub remote keeps the midrun pre-fork history).

- The first crossing of the compaction line still compacts: a result that just entered
  the context is the trailing run (the model is about to read it) and is protected.
  In a long tool loop, however, every later response carrying the same oversized
  results re-crosses the line — each re-compaction is a minutes-long summarization
  pass on local models. Eviction exists to stop that repetition.
- In `_compactBeforeNextAssistantResponse`, before the threshold check: when the
  estimate is already at the line, evict candidate results via context edits, rebuild
  the projection, and let the existing check run on the trimmed context. If it still
  says compact, the normal (bounded) compaction runs.
- Candidates: entries made up solely of tool results, ≥ 4,096 tokens, with at least
  one *healthy* assistant response (stop/toolUse — not length/error/aborted) after
  them, not the trailing run, and not already targeted by a context edit. Largest
  first, evicted until the estimate is at or below `line − max(8192, 5% of window)`.
- Kill switch: `compaction.evict: false`. Diagnostics: one
  `customType: "context-evict"` entry per eviction batch (TUI-invisible without a
  renderer; the `context_edit` entries themselves are the audit trail).

## Settings for the model above

```json
"compaction": { "reserveTokens": 32768 }
```

- Compaction line: 131,072 − 32,768 = 98,304 (75%) — exactly at the clamp-zone boundary
  (window − maxTokens = 98,304); there is no buffer against provider usage
  underestimates (the previous 40,960 reserve left one). The line scales with the
  window the server reports (e.g. 262,144 today → 229,376) and stays exactly at the
  clamp boundary because the reserve equals the model's maxTokens.
- Summary cap: min(0.8 × (32,768 + 20,000), 32,768) = 32,768 (model ceiling).
- Summarizer thinking: `off` (default) → summary ≈ 5–7k tokens.
- `midRunReserveTokens`: default 16,384 → steer line = 131,072 − max(16,384, 32,768) =
  98,304, coinciding with the compaction line.

## Test findings (upstream edge cases, left as-is)

- Oversized trailing tool result: fixed upstream in v0.86.0 — `findCutPoint` now keeps
  the preceding assistant tool call instead of falling back to the first message, so a
  mid-run compaction splits the turn instead of no-op'ing (covered by the upstream
  "compacts after an oversized tool result" characterization tests).
- Threshold compaction on a run that ended in `stop` does not continue the run; it
  compacts and ends. The user's next prompt starts on the compacted context.
- `estimateContextTokens` on the steer hook path uses message estimates; faux/test
  providers report usage as ~chars/4 with no cache doubling.

## Tests

- Fork: `test/compaction-summary-reasoning.test.ts` (thinking pass-through, cap, length
  retry), `test/suite/agent-session-midrun.test.ts` (steer → mid-run compaction →
  invisible resume; silence below the line; summarizer thinking-level resolution:
  default off / inherit / concrete), `test/suite/agent-session-context-evict.test.ts`
  (eviction prevents a second compaction on a consumed oversized result; silence below
  the line; compaction when nothing is evictable; the `compaction.evict: false`
  control compacts repeatedly; multi-eviction until below the buffered line),
  `test/suite/regressions/7048-…`.
- Upstream tests adapted to fork behavior:
  `test/suite/agent-session-compaction-model-overrides.test.ts` (summary budgets now
  include the kept-recent slack: `0.8 × (reserve + keepRecent)`) and
  `test/suite/regressions/9178-…` (ignore the fork's invisible midrun diagnostic
  entries when asserting on the last session entry).
- coding-agent suite: 2,417 passed, 50 skipped, 0 failed; monorepo `./test.sh`: 5,113
  passed, 904 skipped, 0 failed (run after `npm run build`; the workspace test suites
  resolve against the built `dist` of the workspace packages).

## Install (this machine)

Global npm install at the `~/.local` prefix, same layout as pi.dev's
`install.sh` (CLI runs `dist/bundle`, extensions import `dist/index.js`;
deps nested under the package). Uninstall the old version, then install a
tarball packed from this repo:

```sh
npm uninstall -g @earendil-works/pi-coding-agent
cd <this repo> && npm run build        # before tests and packing
cd packages/coding-agent && npm pack
npm install -g --ignore-scripts --min-release-age=0 \
  --no-fund --no-audit earendil-works-pi-coding-agent-0.87.0.tgz
```

`--min-release-age=0` matches the installer: local npm config gates registry
releases by age. The sibling workspace packages (`pi-ai`, `pi-agent-core`,
`chord`, …) stay the published release versions, pinned by the packaged
`npm-shrinkwrap.json`; only `pi-coding-agent` itself is the fork.

The external `midrun-autocompact` extension was removed from `~/.pi/agent/settings.json`
`packages` (now vestigial; lives on in `github.com/hitori-chan/pi-extensions` as the
pre-fork history of this code).
