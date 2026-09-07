/**
 * Mid-run convergence steering.
 *
 * A tool loop can run far past the compaction line without ever reaching a
 * compaction boundary. Once a run's context usage crosses the steer line
 * (pi's own compaction line by default), the model receives an invisible
 * note asking it to converge in-flight work and end the turn, so pi's native
 * boundary compaction runs on a settled state. When the steered run settles,
 * an invisible resume note continues the task — following the compaction
 * summary when one was produced.
 *
 * All messages are invisible to the UI (`display: false`). Diagnostics are
 * recorded in the session file as `midrun-autocompact` custom entries.
 */

/** customType for steering/resume messages and diagnostic entries. */
export const MIDRUN_CUSTOM_TYPE = "midrun-autocompact";

/** Steer exactly at pi's own compaction line by default; raise to steer earlier. */
export const DEFAULT_MIDRUN_RESERVE_TOKENS = 16384;

/** Hysteresis floor: only steer again after this much real growth. */
const REARM_DELTA_TOKENS = 8192;

/** Re-arm delta scales with the window (a fixed floor is a rounding error on a 1M window). */
const REARM_WINDOW_FRACTION = 0.05;

/** First steer + one stronger re-nudge per run. */
export const MAX_NUDGES_PER_RUN = 2;

/** Re-arm delta: the fixed floor, scaled up for large windows. */
export function rearmDeltaTokens(contextWindow: number): number {
	return Math.max(REARM_DELTA_TOKENS, Math.floor(contextWindow * REARM_WINDOW_FRACTION));
}

/** Invisible wrap-up note (steer): converge, end the turn, leave a state line. */
export function steerPrompt(pct: number): string {
	return `[System note] Context is at ${pct}% of the limit. When this turn ends, the conversation may be compacted into a structured context checkpoint summary that a continuation will use to resume the work.
Finish the step you are on now — converge any in-flight edits so the state is consistent — then end your turn. Do not start new work.
End your reply with one short line stating the exact current state: what is done, what remains.`;
}

/** Stronger re-nudge, only when the first note was ignored: stop now. */
export function reSteerPrompt(pct: number): string {
	return `[System note] Context is now at ${pct}% of the limit — the earlier wrap-up request was not actioned. Stop immediately: do not start any further tool calls. End your current step right away and end your turn now.
End your reply with one short line stating the exact current state: what is done, what remains.`;
}

/** Resume (compacted): the summary above is authoritative; follow Next Steps. */
export const RESUME_PROMPT_COMPACTED = `[System note] This run resumes from a context checkpoint: the earlier conversation was compacted into the structured summary above. Treat that summary as the authoritative record of the work so far.
Continue the task exactly where it left off — follow the summary's Next Steps and build on the work already done; do not restart or redo it.
The summary lists the files read and modified since the last checkpoint — check those lists before re-reading any file.
If the task is already complete, reply with a short completion summary instead of continuing.`;

/** Resume (not compacted): the conversation is intact; continue. */
export const RESUME_PROMPT_PLAIN = `[System note] The previous turn paused briefly for context management. Continue the task exactly where it left off — do not restart or redo completed work, and do not comment on the pause.
If the task is already complete, reply with a short completion summary instead of continuing.`;
