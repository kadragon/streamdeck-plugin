import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIN_TAB = 1;
const MAX_TAB = 8;

/** Mirrors EVENT_TTL_MS in src/agent-attention/spool.ts, which owns the value. */
const EVENT_TTL_MS = 10 * 60 * 1000;

/**
 * Resolves the same local spool directory used by the Stream Deck plugin.
 * Set AGENT_ATTENTION_STATE_DIR when the hook runs in WSL or another environment with a different
 * home directory from the Stream Deck process.
 */
export function resolveStateDirectory(env = process.env, platform = process.platform) {
	const configured = env.AGENT_ATTENTION_STATE_DIR?.trim();
	if (configured) {
		return path.resolve(configured);
	}

	const home = os.homedir();
	if (platform === "win32") {
		return path.join(env.LOCALAPPDATA ?? env.APPDATA ?? home, "AIUsageStreamDeck", "agent-attention");
	}

	if (platform === "darwin") {
		return path.join(home, "Library", "Application Support", "AIUsageStreamDeck", "agent-attention");
	}

	return path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "ai-usage-streamdeck", "agent-attention");
}

export function normalizeSource(value) {
	const source = String(value ?? "").trim().toLowerCase();
	return source === "claude" || source === "codex" ? source : undefined;
}

export function normalizeTab(value) {
	const tab = Number(String(value ?? "").trim());
	return Number.isInteger(tab) && tab >= MIN_TAB && tab <= MAX_TAB ? tab : undefined;
}

/** Writes one complete event into the atomic per-event spool. */
export async function writeAgentEvent(event, stateDirectory = resolveStateDirectory()) {
	const directory = path.join(stateDirectory, "events");
	await fs.mkdir(directory, { recursive: true });

	const temporaryPath = path.join(directory, `.${Date.now()}-${process.pid}-${randomUUID()}.tmp`);
	const finalPath = `${temporaryPath.slice(0, -4)}.json`;
	try {
		await fs.writeFile(temporaryPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "wx" });
		await fs.rename(temporaryPath, finalPath);
	} catch (error) {
		await fs.unlink(temporaryPath).catch(() => undefined);
		throw error;
	}

	await pruneStaleEvents(directory);
}

/**
 * Drops spool files older than EVENT_TTL_MS so the directory stays bounded when the Stream Deck
 * plugin never runs and nothing consumes it. Every writer name starts with the epoch milliseconds
 * it was created at, so staleness is read from the name, and orphaned .tmp files from a crashed
 * writer are covered by the same rule. Failures are swallowed: pruning must never fail a
 * published event.
 */
async function pruneStaleEvents(directory) {
	try {
		const names = await fs.readdir(directory);
		const cutoff = Date.now() - EVENT_TTL_MS;
		await Promise.all(
			names
				.filter((name) => {
					const createdAt = parseEventCreationTime(name);
					return createdAt !== undefined && createdAt < cutoff;
				})
				.map(async (name) => fs.unlink(path.join(directory, name)).catch(() => undefined))
		);
	} catch {
		// A spool that cannot be pruned is still a spool that accepted the event.
	}
}

/** Reads the epoch milliseconds a writer encoded into a spool file name, or undefined if foreign. */
function parseEventCreationTime(name) {
	const match = /^\.(\d+)-\d+-.+\.(?:json|tmp)$/.exec(name);
	if (match === null) {
		return undefined;
	}

	const createdAt = Number(match[1]);
	return Number.isFinite(createdAt) ? createdAt : undefined;
}

export function classifyHookEvent(source, input) {
	const eventName = typeof input?.hook_event_name === "string" ? input.hook_event_name : "";

	if (eventName === "SessionEnd") {
		return { status: "exited", reason: "session-end" };
	}

	if (eventName === "SessionStart" || eventName === "UserPromptSubmit") {
		return { status: "running", reason: "prompt" };
	}

	if (eventName === "Stop") {
		return { status: "attention", reason: "completed" };
	}

	if (source === "claude" && eventName === "Notification") {
		const notificationType = input.notification_type;
		if (notificationType === "permission_prompt") {
			return { status: "attention", reason: "permission" };
		}
		if (notificationType === "idle_prompt") {
			return { status: "attention", reason: "input" };
		}
		if (notificationType === "elicitation_dialog") {
			return { status: "attention", reason: "elicitation" };
		}
		if (notificationType === "agent_needs_input") {
			return { status: "attention", reason: "input" };
		}
		if (notificationType === "agent_completed") {
			return { status: "attention", reason: "completed" };
		}
	}

	if (source === "codex" && eventName === "PermissionRequest") {
		return { status: "attention", reason: "permission" };
	}

	if (["PreToolUse", "PostToolUse", "PostToolBatch", "PreCompact", "PostCompact"].includes(eventName)) {
		return { status: "running", reason: "activity" };
	}

	return undefined;
}

async function main() {
	const source = normalizeSource(readOption("--source"));
	if (source === undefined) {
		return;
	}

	const inputText = await readStdin();
	let input;
	try {
		input = inputText.trim() === "" ? {} : JSON.parse(inputText);
	} catch {
		return;
	}

	const record = input !== null && typeof input === "object" ? input : {};
	const transition = classifyHookEvent(source, record);
	const runtimeId = process.env.AGENT_ATTENTION_RUNTIME_ID?.trim() || record.session_id;
	const tab = normalizeTab(process.env.AGENT_ATTENTION_TAB);
	if (transition === undefined || typeof runtimeId !== "string" || runtimeId.trim() === "" || tab === undefined) {
		return;
	}

	const cwd = typeof record.cwd === "string" && record.cwd.trim() !== "" ? record.cwd : process.cwd();
	await writeAgentEvent(
		{
			source,
			runtimeId,
			slot: tab,
			cwd,
			status: transition.status,
			reason: transition.reason,
			timestamp: new Date().toISOString()
		},
		resolveStateDirectory()
	);
}

function readOption(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch(() => {
		// Hook side effects must never block or alter the agent turn.
		process.exitCode = 0;
	});
}
