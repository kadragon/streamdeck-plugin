import assert from "node:assert/strict";
import { test } from "node:test";

import { streamDeck, type DidReceiveSettingsEvent, type KeyDownEvent, type WillAppearEvent } from "@elgato/streamdeck";

import { HcAgentStatus } from "../src/actions/hc-agent-status";
import { parseHcAgentStatus } from "../src/hc/status";
import { renderHcAgentKey } from "../src/render";

test("groups live working and waiting HC terminals by display mode", () => {
	const terminals = [
		{ state: "live", agent: "powershell.exe" },
		{ state: "live", agent: "codex", address: "t2", status: "working" },
		{ state: "live", agent: "claude-code", status: "working" },
		{ state: "live", agent: "codex", address: "t3", status: "blocked" },
		{ state: "live", agent: "claude-code", address: "t6", status: "blocked" },
		{ state: "live", agent: "codex", address: "t7", status: "idle" },
		{ state: "live", agent: "claude-code", address: "t9", status: "done" },
		{ state: "live", status: "error" },
		{ state: "finished", status: "blocked" }
	];
	assert.deepEqual(parseHcAgentStatus(JSON.stringify({ terminals })), {
		running: ["t2", undefined],
		waiting: ["t3", "t6", "t7", "t9"]
	});
});

test("rejects malformed output rather than interpreting it as zero", () => {
	assert.throws(() => parseHcAgentStatus(""));
	assert.throws(() => parseHcAgentStatus('{"error":{"kind":"unavailable"}}'), /Invalid HC terminal list/);
	assert.throws(() => parseHcAgentStatus('{"terminals":[null]}'), /Invalid HC terminal state/);
	assert.throws(() => parseHcAgentStatus('{"terminals":[{"state":"live","status":4}]}'), /Invalid HC terminal status/);
});

test("renders empty and unavailable counts distinctly", () => {
	const svg = (image: string) => decodeURIComponent(image.split(",")[1]);
	const zero = parseHcAgentStatus('{"terminals":[]}');
	const reading = parseHcAgentStatus(JSON.stringify({ terminals: [
		{ state: "live", status: "working" },
		{ state: "live", status: "working" },
		{ state: "live", status: "blocked", agent: "codex" },
		{ state: "live", status: "idle" },
		{ state: "live", status: "done" }
	] }));
	assert.match(svg(renderHcAgentKey("waiting", zero)), />0<\/text>/);
	assert.match(svg(renderHcAgentKey("waiting", undefined)), />--<\/text>/);
	const running = svg(renderHcAgentKey("running", reading));
	const waiting = svg(renderHcAgentKey("waiting", reading));
	assert.match(running, />2<\/text>[\s\S]*>RUNNING<\/text>/);
	assert.doesNotMatch(running, /WAITING/);
	assert.match(waiting, />3<\/text>[\s\S]*>WAITING<\/text>/);
	assert.doesNotMatch(waiting, /RUNNING|codex|>HC</);
	assert.match(waiting, /font-size="72">3<\/text>/);
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
			id: "hc-key",
			isKey: () => true,
			setTitle: async () => {
				throw new Error("SDK title update failed");
			}
		},
		payload: { settings: {} }
	} as unknown as WillAppearEvent;
	await action.onWillAppear(event);
	assert.equal(refreshed, true);
	assert.equal(log.mock.callCount(), 1);
});

test("Running and Waiting keys cycle through their own live terminals independently", async () => {
	const terminal = (status: string, address?: string) => ({ state: "live", status, address });
	let terminals = [terminal("blocked"), terminal("blocked", "t3"), terminal("working", "t4"),
		terminal("done", "t9"), terminal("working"), terminal("working", "t5")];
	const focused: string[] = [];
	const action = new HcAgentStatus(
		async () => parseHcAgentStatus(JSON.stringify({ terminals })),
		async (address) => { focused.push(address); }
	);
	const running = { id: "running", isKey: () => true, setImage: async () => {} };
	const waiting = { ...running, id: "waiting" };
	Object.defineProperty(action, "actions", { value: [running, waiting] });
	const press = (key: typeof running) => action.onKeyDown({ action: key } as unknown as KeyDownEvent);

	await action.onDidReceiveSettings({ action: waiting, payload: { settings: { mode: "waiting" } } } as unknown as DidReceiveSettingsEvent);
	await Promise.all([press(waiting), press(waiting), press(running)]);
	await press(waiting);
	await press(running);
	await press(running);
	await press(waiting);
	assert.deepEqual(focused, ["t3", "t4", "t9", "t5", "t4", "t3"]);
	terminals = [terminal("blocked"), terminal("working")];
	await press(waiting);
	await press(running);
	assert.equal(focused.length, 6);
});
