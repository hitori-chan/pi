import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextEditEntry, SessionEntry } from "../../src/core/session-manager.ts";
import type { InlineExtension } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

// Window 40000, reserve 8000 -> line 32000. midRunReserveTokens = window
// disables mid-run steering so the tests isolate eviction.
//
// Semantics under test: when a tool result first enters the context it is the
// trailing run (the model is about to read it), so the first crossing still
// compacts (or no-ops when nothing precedes the keep-recent budget). Once the
// model has consumed a result into a subsequent response, eviction omits it
// before the next crossing — preventing repeated compactions in long tool
// loops, each of which is a minutes-long summarization pass on local models.
const SETTINGS = {
	compaction: {
		enabled: true,
		reserveTokens: 8000,
		keepRecentTokens: 2000,
		midRunReserveTokens: 40000,
	},
};

const BIG_CHARS = 160000; // ~40000 estimated tokens

function makeTool(name: string, marker: string | undefined, chars: number): AgentTool {
	const text = marker ? `${marker}${"x".repeat(chars - marker.length)}` : "x".repeat(chars);
	return {
		name,
		label: name,
		description: "Returns filler text",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text }], details: {} }),
	};
}

function makeSummarizingFactory(): InlineExtension {
	return (pi) => {
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "compacted history",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {},
			},
		}));
	};
}

function messageText(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const content = (entry.message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: string; text?: string } => (part as { type?: unknown }).type === "text")
			.map((part) => part.text ?? "")
			.join("\n");
	}
	return "";
}

const contextEdits = (harness: Harness) =>
	harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit") as ContextEditEntry[];

const compactionCount = (harness: Harness) =>
	harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;

const evictDiagnostics = (harness: Harness) =>
	harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "context-evict");

describe("stale tool-result eviction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("evicts a consumed oversized result, preventing a second compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 40000, maxTokens: 2000 }],
			settings: SETTINGS,
			tools: [makeTool("big", "EVICT-MARKER-A", BIG_CHARS), makeTool("small", "EVICT-MARKER-S", 14)],
			extensionFactories: [makeSummarizingFactory()],
		});
		harnesses.push(harness);

		const requests: string[] = [];
		const next =
			(body: Parameters<typeof fauxAssistantMessage>[0], stopReason?: "toolUse") =>
			(context: { messages: unknown[] }) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(body, stopReason ? { stopReason } : undefined);
			};
		harness.setResponses([
			// First prompt: some small work to make the first compaction real.
			next(fauxToolCall("small", {}), "toolUse"),
			next("one done"),
			// Second prompt: the oversized result enters the context.
			next(fauxToolCall("big", {}), "toolUse"),
			// The model consumes the big result, then calls a small tool.
			next(fauxToolCall("small", {}), "toolUse"),
			next("done"),
		]);

		await harness.session.prompt("step one");
		await harness.session.prompt("now the big thing");

		expect(requests).toHaveLength(5);
		// Request 4 carries the big result so the model consumes it (the first
		// crossing compacts: the result is the trailing run and protected).
		expect(requests[3]).toContain("EVICT-MARKER-A");
		expect(requests[3]).toContain("compacted history");
		// Request 5: the consumed big result was evicted; the trailing small
		// result stays, and no second compaction ran.
		expect(requests[4]).not.toContain("EVICT-MARKER-A");
		expect(requests[4]).toContain("EVICT-MARKER-S");

		const bigEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && messageText(entry).includes("EVICT-MARKER-A"));
		if (!bigEntry) throw new Error("big tool result entry not found");
		const edits = contextEdits(harness);
		expect(edits).toHaveLength(1);
		expect(edits[0].targetId).toBe(bigEntry.id);
		expect(edits[0].replacement).toBeNull();
		expect(evictDiagnostics(harness)).toHaveLength(1);
		expect(compactionCount(harness)).toBe(1);
	});

	it("does not steer when eviction resolves the crossing", async () => {
		// keepRecent 50000 > the big result: the first crossing compacts to
		// nothing (no summarizable prefix), so the only question is whether the
		// consumed result later stops the run. Steer line = line = 32000.
		const settings = {
			compaction: {
				enabled: true,
				reserveTokens: 8000,
				keepRecentTokens: 50000,
				midRunReserveTokens: 8000,
			},
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 40000, maxTokens: 2000 }],
			settings,
			tools: [makeTool("big", "EVICT-MARKER-A", BIG_CHARS), makeTool("small", "EVICT-MARKER-S", 14)],
			extensionFactories: [makeSummarizingFactory()],
		});
		harnesses.push(harness);

		const requests: string[] = [];
		const next =
			(body: Parameters<typeof fauxAssistantMessage>[0], stopReason?: "toolUse") =>
			(context: { messages: unknown[] }) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(body, stopReason ? { stopReason } : undefined);
			};
		harness.setResponses([
			next(fauxToolCall("big", {}), "toolUse"),
			next(fauxToolCall("small", {}), "toolUse"),
			next("done"),
		]);

		await harness.session.prompt("run the big tool");

		expect(requests).toHaveLength(3);
		expect(requests[2]).not.toContain("EVICT-MARKER-A");
		expect(requests[2]).toContain("EVICT-MARKER-S");
		// The crossing after the digest was resolved by eviction: no steer note,
		// no compaction, the run finished on its own.
		const midrun = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "midrun-autocompact");
		expect(midrun).toHaveLength(0);
		expect(contextEdits(harness)).toHaveLength(1);
		expect(compactionCount(harness)).toBe(0);
	});

	it("steers and re-compacts when eviction is off (control)", async () => {
		const settings = {
			compaction: {
				enabled: true,
				reserveTokens: 8000,
				keepRecentTokens: 2000,
				midRunReserveTokens: 8000,
				evict: false,
			},
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 40000, maxTokens: 2000 }],
			settings,
			tools: [makeTool("big", "EVICT-MARKER-A", BIG_CHARS), makeTool("small", "EVICT-MARKER-S", 14)],
			extensionFactories: [makeSummarizingFactory()],
		});
		harnesses.push(harness);

		const requests: string[] = [];
		const next =
			(body: Parameters<typeof fauxAssistantMessage>[0], stopReason?: "toolUse") =>
			(context: { messages: unknown[] }) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(body, stopReason ? { stopReason } : undefined);
			};
		harness.setResponses([
			next(fauxToolCall("big", {}), "toolUse"),
			next(fauxToolCall("small", {}), "toolUse"),
			next("done"),
		]);

		await harness.session.prompt("run the big tool");

		expect(requests).toHaveLength(3);
		// Without eviction the consumed big result keeps every later request
		// over the line: the run is steered to stop and re-compacts.
		expect(requests.some((r) => r.includes("[System note] Context is at"))).toBe(true);
		const steerPhases = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "midrun-autocompact")
			.map((entry) => (entry as { data?: { phase?: string } }).data?.phase);
		expect(steerPhases.filter((phase) => phase === "steer")).toHaveLength(1);
		expect(contextEdits(harness)).toHaveLength(0);
		expect(compactionCount(harness)).toBe(2);
	});

	it("stays silent below the compaction line", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 40000, maxTokens: 2000 }],
			settings: SETTINGS,
			tools: [makeTool("small", "EVICT-MARKER-S", 14)],
			extensionFactories: [makeSummarizingFactory()],
		});
		harnesses.push(harness);

		harness.setResponses([
			(_context) => fauxAssistantMessage(fauxToolCall("small", {}), { stopReason: "toolUse" }),
			(_context) => fauxAssistantMessage("all done"),
		]);

		await harness.session.prompt("run the small tool");

		expect(contextEdits(harness)).toHaveLength(0);
		expect(evictDiagnostics(harness)).toHaveLength(0);
		expect(compactionCount(harness)).toBe(0);
	});

	it("compacts when nothing is evictable (the overage is not stale tool output)", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 40000, maxTokens: 2000 }],
			settings: SETTINGS,
			tools: [makeTool("small", "EVICT-MARKER-S", 14)],
			extensionFactories: [makeSummarizingFactory()],
		});
		harnesses.push(harness);

		const requests: string[] = [];
		const next =
			(body: Parameters<typeof fauxAssistantMessage>[0], stopReason?: "toolUse") =>
			(context: { messages: unknown[] }) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(body, stopReason ? { stopReason } : undefined);
			};
		harness.setResponses([
			next(fauxToolCall("small", {}), "toolUse"),
			next("one done"),
			next(fauxToolCall("small", {}), "toolUse"),
			next("done"),
		]);

		// First: some small work (below the line, evictable-size nothing).
		await harness.session.prompt("do the first step");

		// Then a ~140000-char prompt (~35000 tokens) crosses the 32000 line by
		// itself: user text is not evictable, so compaction must run on the
		// earlier work.
		await harness.session.prompt(`huge prompt\n${"a".repeat(140000)}`);

		expect(contextEdits(harness)).toHaveLength(0);
		expect(compactionCount(harness)).toBe(1);
		expect(requests[requests.length - 1]).toContain("compacted history");
	});

	it("compacts repeatedly when compaction.evict is false", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 40000, maxTokens: 2000 }],
			settings: { ...SETTINGS, compaction: { ...SETTINGS.compaction, evict: false } },
			tools: [makeTool("big", "EVICT-MARKER-A", BIG_CHARS), makeTool("small", "EVICT-MARKER-S", 14)],
			extensionFactories: [makeSummarizingFactory()],
		});
		harnesses.push(harness);

		const requests: string[] = [];
		const next =
			(body: Parameters<typeof fauxAssistantMessage>[0], stopReason?: "toolUse") =>
			(context: { messages: unknown[] }) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(body, stopReason ? { stopReason } : undefined);
			};
		harness.setResponses([
			next(fauxToolCall("small", {}), "toolUse"),
			next("one done"),
			next(fauxToolCall("big", {}), "toolUse"),
			next(fauxToolCall("small", {}), "toolUse"),
			next("done"),
		]);

		await harness.session.prompt("step one");
		await harness.session.prompt("now the big thing");

		// Without eviction the crossing re-triggers on every subsequent
		// response that carries the big result: two compactions, no edits.
		expect(requests).toHaveLength(5);
		expect(requests[4]).toContain("compacted history");
		expect(contextEdits(harness)).toHaveLength(0);
		expect(evictDiagnostics(harness)).toHaveLength(0);
		expect(compactionCount(harness)).toBe(2);
	});

	it("evicts several results until the estimate is below the buffered line", async () => {
		// Window 30000, reserve 4000 -> line 26000, buffer 8192 -> target 17808.
		const settings = {
			compaction: {
				enabled: true,
				reserveTokens: 4000,
				keepRecentTokens: 2000,
				midRunReserveTokens: 30000,
			},
		};
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 30000, maxTokens: 2000 }],
			settings,
			tools: [
				makeTool("med-1", "EVICT-MARKER-1", 30000),
				makeTool("med-2", "EVICT-MARKER-2", 30000),
				makeTool("med-3", "EVICT-MARKER-3", 30000),
				makeTool("med-4", "EVICT-MARKER-4", 30000),
				makeTool("med-5", "EVICT-MARKER-5", 30000),
			],
			extensionFactories: [makeSummarizingFactory()],
		});
		harnesses.push(harness);

		const requests: string[] = [];
		const next = (tool: string) => (context: { messages: unknown[] }) => {
			requests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage(fauxToolCall(tool, {}), { stopReason: "toolUse" });
		};
		harness.setResponses([
			next("med-1"),
			next("med-2"),
			next("med-3"),
			next("med-4"),
			next("med-5"),
			(context: { messages: unknown[] }) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("run the tools");

		// Six requests; the final one keeps the trailing result (M5) and drops
		// at least the two oldest consumed results.
		expect(requests).toHaveLength(6);
		const last = requests[requests.length - 1];
		expect(last).toContain("EVICT-MARKER-5");
		expect(last).not.toContain("EVICT-MARKER-1");
		expect(last).not.toContain("EVICT-MARKER-2");
		const edits = contextEdits(harness);
		expect(edits.length).toBeGreaterThanOrEqual(2);
		for (const edit of edits) expect(edit.replacement).toBeNull();
		expect(compactionCount(harness)).toBe(0);
	});
});
