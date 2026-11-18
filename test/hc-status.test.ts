import assert from "node:assert/strict";
import { test } from "node:test";

import { streamDeck, type WillAppearEvent } from "@elgato/streamdeck";

import { HcAgentStatus } from "../src/actions/hc-agent-status";
import { parseHcAgentCounts } from "../src/hc/status";
import { renderHcAgentKey } from "../src/render";

test("counts live working and blocked HC sessions", () => {
	const terminals = [
		{ state: "live", agent: "powershell.exe" },
		{ state: "live", agent: "codex", status: "working" },
		{ state: "live", agent: "claude-code", status: "working" },
		{ state: "live", agent: "codex", status: "blocked" },
		{ state: "live", status: "idle" },
		{ state: "live", status: "done" },
		{ state: "live", status: "error" },
		{ state: "finished", status: "blocked" }
	];
	assert.deepEqual(parseHcAgentCounts(JSON.stringify({ terminals })), { working: 2, waiting: 1 });
});

test("rejects malformed output rather than interpreting it as zero", () => {
	assert.throws(() => parseHcAgentCounts(""));
	assert.throws(() => parseHcAgentCounts('{"error":{"kind":"unavailable"}}'), /Invalid HC terminal list/);
	assert.throws(() => parseHcAgentCounts('{"terminals":[null]}'), /Invalid HC terminal state/);
	assert.throws(() => parseHcAgentCounts('{"terminals":[{"state":"live","status":4}]}'), /Invalid HC terminal status/);
});

test("renders empty and unavailable counts distinctly", () => {
	const svg = (image: string) => decodeURIComponent(image.split(",")[1]);
	const zero = svg(renderHcAgentKey(parseHcAgentCounts('{"terminals":[]}')));
	const unavailable = svg(renderHcAgentKey(undefined));
	const active = svg(renderHcAgentKey({ working: 2, waiting: 1 }));
	assert.equal(zero.match(/>0<\/text>/g)?.length, 2);
	assert.equal(unavailable.match(/>--<\/text>/g)?.length, 2);
	assert.match(active, />2<\/text>[\s\S]*>1<\/text>[\s\S]*>RUNNING<\/text>[\s\S]*>WAITING<\/text>/);
});

test("refreshes when the SDK rejects clearing the key title", async (context) => {
	const log = context.mock.method(streamDeck.logger, "error", () => {});
	const action = new HcAgentStatus();
	let refreshed = false;
	action.refreshAll = async () => {
		refreshed = true;
	};
	const event = {
		action: {
			isKey: () => true,
			setTitle: async () => {
				throw new Error("SDK title update failed");
			}
		}
	} as unknown as WillAppearEvent;
	await action.onWillAppear(event);
	assert.equal(refreshed, true);
	assert.equal(log.mock.callCount(), 1);
});
