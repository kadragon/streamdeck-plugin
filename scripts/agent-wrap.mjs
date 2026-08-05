import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

import { normalizeSource, normalizeTab, resolveStateDirectory, writeAgentEvent } from "./agent-event.mjs";

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.error !== undefined || options.command === undefined) {
		console.error(options.error ?? usage());
		process.exitCode = 2;
		return;
	}

	const source = normalizeSource(options.source);
	const tab = normalizeTab(options.tab);
	if (source === undefined || tab === undefined) {
		console.error("--source must be claude or codex and --tab must be an integer from 1 to 8");
		process.exitCode = 2;
		return;
	}

	const runtimeId = randomUUID();
	const stateDirectory = options.stateDirectory === undefined ? resolveStateDirectory() : path.resolve(options.stateDirectory);
	const env = {
		...process.env,
		AGENT_ATTENTION_SOURCE: source,
		AGENT_ATTENTION_TAB: String(tab),
		AGENT_ATTENTION_RUNTIME_ID: runtimeId,
		AGENT_ATTENTION_STATE_DIR: stateDirectory
	};

	await publish(
		{
			source,
			runtimeId,
			slot: tab,
			cwd: process.cwd(),
			status: "started",
			reason: "process-start",
			timestamp: new Date().toISOString()
		},
		stateDirectory
	);

	const child = spawn(options.command, options.commandArguments, {
		cwd: process.cwd(),
		env,
		stdio: "inherit",
		windowsHide: false
	});

	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.once(signal, () => {
			try {
				child.kill(signal);
			} catch {
				child.kill();
			}
		});
	}

	child.once("error", async (error) => {
		await publish(
			{
				source,
				runtimeId,
				slot: tab,
				cwd: process.cwd(),
				status: "exited",
				reason: "process-error",
				timestamp: new Date().toISOString()
			},
			stateDirectory
		);
		console.error(`failed to start ${options.command}: ${error.message}`);
		process.exitCode = 1;
	});

	child.once("exit", async (code, signal) => {
		await publish(
			{
				source,
				runtimeId,
				slot: tab,
				cwd: process.cwd(),
				status: "exited",
				reason: signal === null ? "process-exit" : `signal-${signal}`,
				timestamp: new Date().toISOString()
			},
			stateDirectory
		);
		process.exitCode = code ?? 1;
	});
}

function parseArguments(argumentsList) {
	const options = { source: undefined, tab: undefined, stateDirectory: undefined, command: undefined, commandArguments: [] };
	const separator = argumentsList.indexOf("--");
	const optionArguments = separator >= 0 ? argumentsList.slice(0, separator) : argumentsList;
	const commandArguments = separator >= 0 ? argumentsList.slice(separator + 1) : [];

	for (let index = 0; index < optionArguments.length; index += 1) {
		const name = optionArguments[index];
		if (name === "--source" || name === "--tab" || name === "--state-dir") {
			const value = optionArguments[index + 1];
			if (value === undefined) {
				return { error: `${name} requires a value` };
			}
			if (name === "--source") options.source = value;
			if (name === "--tab") options.tab = value;
			if (name === "--state-dir") options.stateDirectory = value;
			index += 1;
			continue;
		}

		return { error: `unknown option: ${name}` };
	}

	if (separator < 0 || commandArguments.length === 0) {
		return { error: usage() };
	}

	return { ...options, command: commandArguments[0], commandArguments: commandArguments.slice(1) };
}

function usage() {
	return "Usage: node scripts/agent-wrap.mjs --source claude|codex --tab 1-8 [--state-dir PATH] -- COMMAND [ARGS...]";
}

async function publish(event, stateDirectory) {
	try {
		await writeAgentEvent(event, stateDirectory);
	} catch (error) {
		console.error(`agent attention event failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
