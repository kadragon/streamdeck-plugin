import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";

import { classifyHookEvent, writeAgentEvent } from "./agent-event.mjs";
import { resolveCommand } from "./agent-wrap.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-usage-agent-attention-"));

try {
	assert.deepEqual(classifyHookEvent("claude", { hook_event_name: "Stop" }), {
		status: "attention",
		reason: "completed"
	});
	assert.deepEqual(classifyHookEvent("claude", { hook_event_name: "Notification", notification_type: "permission_prompt" }), {
		status: "attention",
		reason: "permission"
	});
	assert.deepEqual(classifyHookEvent("codex", { hook_event_name: "PermissionRequest" }), {
		status: "attention",
		reason: "permission"
	});
	assert.deepEqual(classifyHookEvent("codex", { hook_event_name: "Stop" }), {
		status: "attention",
		reason: "completed"
	});
	assert.deepEqual(classifyHookEvent("codex", { hook_event_name: "UserPromptSubmit" }), {
		status: "running",
		reason: "prompt"
	});
	assert.deepEqual(classifyHookEvent("claude", { hook_event_name: "SessionEnd" }), {
		status: "exited",
		reason: "session-end"
	});

	await writeAgentEvent(
		{
			source: "claude",
			runtimeId: "smoke-runtime",
			slot: 2,
			cwd: root,
			status: "attention",
			reason: "input",
			timestamp: new Date().toISOString()
		},
		root
	);
	const firstFiles = await fs.readdir(path.join(root, "events"));
	assert.equal(firstFiles.length, 1);
	assert.equal(firstFiles[0].endsWith(".json"), true);
	assert.equal(firstFiles[0].includes(".tmp"), false);

	// A writer prunes its own stale files, so the spool stays bounded even when the plugin never
	// runs and nothing consumes it.
	const pruneRoot = path.join(root, "prune");
	const pruneEvents = path.join(pruneRoot, "events");
	await fs.mkdir(pruneEvents, { recursive: true });
	const staleStamp = Date.now() - 20 * 60 * 1000;
	const staleJson = `.${staleStamp}-1234-stale.json`;
	const staleTemporary = `.${staleStamp}-1234-stale.tmp`;
	const foreignName = "keep-me.json";
	await fs.writeFile(path.join(pruneEvents, staleJson), "{}\n", "utf8");
	await fs.writeFile(path.join(pruneEvents, staleTemporary), "{}\n", "utf8");
	await fs.writeFile(path.join(pruneEvents, foreignName), "{}\n", "utf8");

	await writeAgentEvent(
		{
			source: "codex",
			runtimeId: "prune-runtime",
			slot: 1,
			cwd: root,
			status: "running",
			reason: "prompt",
			timestamp: new Date().toISOString()
		},
		pruneRoot
	);
	const prunedFiles = await fs.readdir(pruneEvents);
	assert.equal(prunedFiles.includes(staleJson), false, "stale event file survived the prune");
	assert.equal(prunedFiles.includes(staleTemporary), false, "orphaned temporary file survived the prune");
	assert.equal(prunedFiles.includes(foreignName), true, "prune removed a file it did not write");
	assert.equal(prunedFiles.filter((file) => file.startsWith(".")).length, 1, "fresh event was not the only spooled file");

	const hookState = path.join(root, "hook-state");
	const hookPath = path.resolve("scripts", "agent-event.mjs");
	const hook = spawn(process.execPath, [hookPath, "--source", "claude"], {
		env: {
			...process.env,
			AGENT_ATTENTION_STATE_DIR: hookState,
			AGENT_ATTENTION_RUNTIME_ID: "hook-runtime",
			AGENT_ATTENTION_TAB: "4"
		},
		stdio: ["pipe", "ignore", "ignore"],
		windowsHide: true
	});
	hook.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "not-used", cwd: root, prompt: "not persisted" }));
	const [hookExitCode] = await once(hook, "exit");
	assert.equal(hookExitCode, 0);
	const hookFiles = await fs.readdir(path.join(hookState, "events"));
	assert.equal(hookFiles.length, 1);
	const hookEvent = JSON.parse(await fs.readFile(path.join(hookState, "events", hookFiles[0]), "utf8"));
	assert.deepEqual(
		{ source: hookEvent.source, runtimeId: hookEvent.runtimeId, slot: hookEvent.slot, status: hookEvent.status },
		{ source: "claude", runtimeId: "hook-runtime", slot: 4, status: "attention" }
	);
	assert.equal(Object.hasOwn(hookEvent, "prompt"), false);

	const wrapperPath = path.resolve("scripts", "agent-wrap.mjs");
	const child = spawn(
		process.execPath,
		[wrapperPath, "--source", "codex", "--tab", "3", "--state-dir", root, "--", process.execPath, "-e", "process.exit(0)"],
		{ stdio: "ignore", windowsHide: true }
	);
	const [exitCode] = await once(child, "exit");
	assert.equal(exitCode, 0);

	const eventFiles = await fs.readdir(path.join(root, "events"));
	const events = await Promise.all(
		eventFiles.map(async (file) => JSON.parse(await fs.readFile(path.join(root, "events", file), "utf8")))
	);
	assert.deepEqual(
		events.filter((event) => event.source === "codex").map((event) => event.status).sort(),
		["exited", "started"]
	);

	// `claude` and `codex` are reached by bare name on PATH, and on Windows they are batch shims that
	// spawn cannot launch directly — so the wrapper is exercised against a PATH-resolved name, not
	// only against an absolute executable path.
	assert.equal(resolveCommand("./relative-only", { PATHEXT: ".EXE" }, "linux"), "./relative-only");
	const resolvedNpm = resolveCommand("npm");
	if (process.platform === "win32") {
		assert.equal(path.extname(resolvedNpm) !== "", true, `npm did not resolve to a concrete file: ${resolvedNpm}`);
	}

	const shimRoot = path.join(root, "shim");
	const shimChild = spawn(
		process.execPath,
		[wrapperPath, "--source", "claude", "--tab", "4", "--state-dir", shimRoot, "--", "npm", "--version"],
		{ stdio: "ignore", windowsHide: true }
	);
	const [shimExitCode] = await once(shimChild, "exit");
	assert.equal(shimExitCode, 0, "wrapper failed to launch a PATH-resolved command");

	const shimFiles = await fs.readdir(path.join(shimRoot, "events"));
	const shimEvents = await Promise.all(
		shimFiles.map(async (file) => JSON.parse(await fs.readFile(path.join(shimRoot, "events", file), "utf8")))
	);
	assert.deepEqual(
		shimEvents.map((event) => event.reason).sort(),
		["process-exit", "process-start"]
	);

	console.log("agent attention smoke checks passed");
} finally {
	await fs.rm(root, { recursive: true, force: true });
}
