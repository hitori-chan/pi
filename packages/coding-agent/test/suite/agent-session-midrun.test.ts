import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { InlineExtension } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

// Window 10000. The faux provider estimates usage at ~1/4 of context chars:
// each 6000-char tool result adds ~1500 usage, so a few tool turns cross the
// steer line (2000) and, later, the compaction line (8000). keepRecentTokens
// stays small relative to a single turn so the cut point lands mid-session.
const SETTINGS = {
	compaction: {
		enabled: true,
		reserveTokens: 2000,
		keepRecentTokens: 2000,
		midRunReserveTokens: 8000,
	},
};

const fillerTool: AgentTool = {
	name: "filler",
	label: "Filler",
	description: "Returns a chunk of filler text",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: `filler:${"x".repeat(6000)}` }], details: {} }),
};

const smallTool: AgentTool = {
	name: "small",
	label: "Small",
	description: "Returns a short result",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

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

describe("mid-run convergence steering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	function midrunPhases(harness: Harness): (string | undefined)[] {
		return harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "midrun-autocompact")
			.map((entry) => (entry as { data?: { phase?: string } }).data?.phase);
	}

	it("steers a tool loop past the line, compacts, and resumes via an invisible note", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 1000 }],
			settings: SETTINGS,
			tools: [fillerTool],
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
			next(fauxToolCall("filler", {}), "toolUse"),
			next(fauxToolCall("filler", {}), "toolUse"),
			next(fauxToolCall("filler", {}), "toolUse"),
			next(fauxToolCall("filler", {}), "toolUse"),
			next(fauxToolCall("filler", {}), "toolUse"),
			next("converged, done for now"),
			next("continued after resume"),
		]);

		await harness.session.prompt(`run the filler tool\n${"a".repeat(8000)}`);

		expect(requests).toHaveLength(7);
		// No notes before the first line is crossed.
		expect(requests[0]).not.toContain("[System note]");
		// The steer note was delivered while the loop was still running.
		expect(requests.some((r) => r.includes("[System note] Context is at"))).toBe(true);
		// After the compaction line is crossed, requests are rebuilt from the
		// summary, and the final (resume) request carries the resume note.
		const last = requests[requests.length - 1];
		expect(last).toContain("compacted history");
		expect(last).toContain("[System note] This run resumes from a context checkpoint");
		expect(requests[requests.length - 2]).toContain("compacted history");

		const phases = midrunPhases(harness);
		expect(phases.filter((phase) => phase === "steer")).toHaveLength(1); // hysteresis: no re-steer
		expect(phases.filter((phase) => phase === "compacted")).toHaveLength(1);
		expect(phases.filter((phase) => phase === "resuming")).toHaveLength(1);

		// The steer message itself is invisible.
		const steerEntry = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "midrun-autocompact" &&
					typeof (entry as { content?: unknown }).content === "string" &&
					String((entry as { content?: unknown }).content).startsWith("[System note] Context is at"),
			);
		expect(steerEntry).toBeDefined();
		expect((steerEntry as { display?: boolean }).display).toBe(false);
	});

	it("stays silent when the steer line is never crossed", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 1000 }],
			settings: SETTINGS,
			tools: [smallTool],
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
			next(fauxToolCall("small", {}), "toolUse"),
			next("all done"),
		]);

		// Small prompt + small results: usage stays far below the 2000 steer line.
		await harness.session.prompt("run the small tool twice");

		expect(requests).toHaveLength(3);
		for (const request of requests) expect(request).not.toContain("[System note]");
		expect(midrunPhases(harness)).toHaveLength(0);
	});
});

describe("summarizer thinking level resolution", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	/** Seed a compactable session, run a manual compaction, and capture the summarization request options. */
	async function captureSummarizationOptions(
		harness: Harness,
		sessionThinkingLevel: ThinkingLevel,
	): Promise<SimpleStreamOptions | undefined> {
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		harness.session.agent.state.thinkingLevel = sessionThinkingLevel;
		const model = harness.getModel();
		const now = Date.now();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		let options: SimpleStreamOptions | undefined;
		harness.setResponses([
			(_context, requestOptions) => {
				options = requestOptions;
				return fauxAssistantMessage("summary");
			},
		]);
		await harness.session.compact();
		return options;
	}

	it("summarizes with thinking off by default, even in a reasoning session", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 1000, reasoning: true }],
		});
		harnesses.push(harness);

		const options = await captureSummarizationOptions(harness, "medium");

		expect(options).toBeDefined();
		expect(options?.reasoning).toBeUndefined();
	});

	it("uses the session level when the setting inherits", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 1000, reasoning: true }],
			settings: { compaction: { thinkingLevel: "inherit" } },
		});
		harnesses.push(harness);

		const options = await captureSummarizationOptions(harness, "medium");

		expect(options).toMatchObject({ reasoning: "medium" });
	});

	it("overrides the session level with the setting", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 1000, reasoning: true }],
			settings: { compaction: { thinkingLevel: "low" } },
		});
		harnesses.push(harness);

		const options = await captureSummarizationOptions(harness, "medium");

		expect(options).toMatchObject({ reasoning: "low" });
	});
});
