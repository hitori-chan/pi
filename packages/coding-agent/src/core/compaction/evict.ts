/**
 * Stale tool-result eviction.
 *
 * A tool result that first enters the context is the trailing run — the model
 * is about to read it — so the first crossing of the compaction line still
 * compacts (the result stays protected). But in a long tool loop every later
 * response that carries the same oversized results (large file reads, verbose
 * command output) re-crosses the line and would re-compact — a minutes-long
 * summarization pass each time on local reasoning models. Once the model has
 * consumed a result into a subsequent response, omitting it via append-only
 * context edits (replacement: null) is free: raw history, usage records, and
 * the UI transcript are untouched, only future provider requests change.
 *
 * Layers under mid-run steering: steer (soft nudge) → evict (free, targeted)
 * → compact (last resort). If eviction cannot bring the estimate below
 * line − buffer, or there is nothing evictable, the normal compaction runs
 * unchanged.
 *
 * Policy (conservative):
 * - A tool result is a candidate once at least one healthy assistant response
 *   (stop or toolUse — not length/error/aborted) has been generated after it:
 *   by then the model's own response is the working memory of the output.
 * - The trailing run of tool-result entries — what the next assistant response
 *   is about to read — is never touched, as is anything already targeted by a
 *   context edit.
 * - Results below MIN_EVICT_TOKENS are not worth an edit entry.
 */

import type { ProjectedSessionEntry, SessionEntry, SessionProjection } from "../session-manager.ts";
import { estimateTokens } from "./compaction.ts";

/** customType for the eviction diagnostic entry (TUI-invisible without a renderer). */
export const CONTEXT_EVICT_CUSTOM_TYPE = "context-evict";

/** Skip small results: an edit entry is not worth less than this much context. */
export const MIN_EVICT_TOKENS = 4096;

/**
 * Minimum healthy assistant responses generated after a tool result before it
 * may be evicted. Healthy = stop or toolUse: a truncated/errored response did
 * not digest the result, so the raw output must stay until one does.
 */
const MIN_ASSISTANT_RESPONSES_AFTER = 1;

function isToolResultEntry(entry: ProjectedSessionEntry): boolean {
	return entry.messages.length > 0 && entry.messages.every((message) => message.role === "toolResult");
}

function isHealthyAssistantResponse(entry: ProjectedSessionEntry): boolean {
	return entry.messages.some(
		(message) =>
			message.role === "assistant" &&
			message.stopReason !== "length" &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted",
	);
}

function entryTokens(entry: ProjectedSessionEntry): number {
	return entry.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

export interface EvictionPlanOptions {
	/** Current context estimate in tokens (same estimate the compaction check uses). */
	tokens: number;
	/** The compaction line: contextWindow − reserveTokens. */
	line: number;
	/** Safety margin below the line to reach (e.g. rearmDeltaTokens(window)). */
	bufferTokens: number;
}

/**
 * Plan stale tool-result evictions: returns the target entry ids (largest
 * first) that bring the estimate to at most `line − bufferTokens`. Pure —
 * the caller appends the context edits.
 */
export function planStaleToolResultEvictions(
	projection: SessionProjection,
	branch: SessionEntry[],
	options: EvictionPlanOptions,
): string[] {
	const { tokens, line, bufferTokens } = options;
	const target = line - bufferTokens;
	if (tokens <= target) return [];

	const entries = projection.entries;

	// Anything already targeted by a context edit is never double-edited.
	const edited = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "context_edit") edited.add(entry.targetId);
	}

	// The trailing run of tool-result entries is what the next assistant
	// response is about to read: always protected.
	let trailingStart = entries.length;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (isToolResultEntry(entries[i])) trailingStart = i;
		else break;
	}

	// Healthy assistant responses generated after each entry.
	const healthyAfter = new Array<number>(entries.length).fill(0);
	let responses = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		healthyAfter[i] = responses;
		if (isHealthyAssistantResponse(entries[i])) responses++;
	}

	const candidates = entries
		.map((entry, index) => ({ entry, index, tokens: entryTokens(entry) }))
		.filter(
			({ entry, index, tokens }) =>
				index < trailingStart &&
				healthyAfter[index] >= MIN_ASSISTANT_RESPONSES_AFTER &&
				!edited.has(entry.sourceEntry.id) &&
				isToolResultEntry(entry) &&
				tokens >= MIN_EVICT_TOKENS,
		)
		.sort((a, b) => b.tokens - a.tokens);

	const targetIds: string[] = [];
	let remaining = tokens;
	for (const candidate of candidates) {
		if (remaining <= target) break;
		targetIds.push(candidate.entry.sourceEntry.id);
		remaining -= candidate.tokens;
	}
	return targetIds;
}
