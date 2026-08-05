import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

	const child = spawnCommand(options.command, options.commandArguments, {
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

/**
 * Resolves a bare command name against PATH and PATHEXT.
 *
 * Windows spawn does neither: `claude` and `codex` are usually npm shims (`codex.cmd`), so the
 * documented `-- codex` invocation would fail with ENOENT without this lookup. The command is
 * returned unchanged when nothing matches, so the original spawn error still surfaces.
 */
export function resolveCommand(command, env = process.env, platform = process.platform) {
	if (platform !== "win32") {
		return command;
	}

	const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	const names = path.extname(command) === "" ? extensions.map((extension) => command + extension) : [command];
	const directories = /[\\/]/.test(command)
		? [""]
		: (env.PATH ?? env.Path ?? "").split(path.delimiter).filter((entry) => entry !== "");

	for (const directory of directories) {
		for (const name of names) {
			const candidate = directory === "" ? name : path.join(directory, name);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return command;
}

/**
 * Starts the wrapped command, routing Windows batch shims through the command processor.
 *
 * Node refuses to spawn a `.cmd`/`.bat` file directly, so those are run as an explicit, fully quoted
 * `cmd.exe /d /s /c` line rather than by handing the argument array to `shell: true`, which would
 * lose any argument containing a space.
 */
function spawnCommand(command, commandArguments, options) {
	const executable = resolveCommand(command);
	if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable)) {
		const line = [executable, ...commandArguments].map(quoteForCommandProcessor).join(" ");
		return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
			...options,
			windowsVerbatimArguments: true
		});
	}

	return spawn(executable, commandArguments, options);
}

function quoteForCommandProcessor(value) {
	return `"${String(value).replace(/"/g, '\\"')}"`;
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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
