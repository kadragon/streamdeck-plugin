import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	isAgentEventStatus,
	isUsageSource,
	normalizeWarpTab,
	type AgentEvent
} from "./types";

const EVENT_DIRECTORY_NAME = "events";

/**
 * How old a spooled event may be and still be applied.
 *
 * Hooks keep writing while no Agent Attention key is visible, so the first poll after a key appears
 * can find a long backlog. Replaying it would show state that has since been superseded.
 */
const EVENT_TTL_MS = 10 * 60 * 1000;

/**
 * Resolves the shared local state directory without touching Claude or Codex configuration.
 *
 * AGENT_ATTENTION_STATE_DIR is intentionally supported so setup scripts and smoke checks can use
 * an explicit directory without changing a user's home configuration.
 */
export function resolveAgentAttentionStateDirectory(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform
): string {
	const configured = env.AGENT_ATTENTION_STATE_DIR?.trim();
	if (configured !== undefined && configured !== "") {
		return path.resolve(configured);
	}

	const home = os.homedir();
	if (platform === "win32") {
		return path.join(env.LOCALAPPDATA ?? env.APPDATA ?? home, "AIUsageStreamDeck", "agent-attention");
	}

	if (platform === "darwin") {
		return path.join(home, "Library", "Application Support", "AIUsageStreamDeck", "agent-attention");
	}

	return path.join(
		env.XDG_STATE_HOME ?? path.join(home, ".local", "state"),
		"ai-usage-streamdeck",
		"agent-attention"
	);
}

export function eventDirectory(stateDirectory = resolveAgentAttentionStateDirectory()): string {
	return path.join(stateDirectory, EVENT_DIRECTORY_NAME);
}

/**
 * Publishes one event by renaming a fully written file into the spool.
 *
 * Each writer uses a unique temporary name, so concurrent wrappers/hooks never append to or replace
 * one another's JSON.
 */
export async function writeAgentEvent(
	event: AgentEvent,
	stateDirectory = resolveAgentAttentionStateDirectory()
): Promise<void> {
	const directory = eventDirectory(stateDirectory);
	await fs.mkdir(directory, { recursive: true });

	const suffix = randomUUID();
	const temporaryPath = path.join(directory, "." + Date.now() + "-" + process.pid + "-" + suffix + ".tmp");
	const finalPath = temporaryPath.slice(0, -4) + ".json";
	const payload = JSON.stringify(event) + "\n";

	try {
		await fs.writeFile(temporaryPath, payload, { encoding: "utf8", flag: "wx" });
		await fs.rename(temporaryPath, finalPath);
	} catch (error) {
		await fs.unlink(temporaryPath).catch(() => undefined);
		throw error;
	}

	await pruneStaleEvents(directory);
}

/**
 * Drops spool files older than EVENT_TTL_MS so the directory stays bounded when nothing reads it.
 *
 * The reader only prunes while it polls, and hooks keep writing while no Agent Attention key is
 * visible. Every writer name starts with the epoch milliseconds it was created at, so staleness is
 * read from the name instead of a stat call, and orphaned .tmp files from a crashed writer are
 * covered by the same rule. Failures are swallowed: pruning must never fail a published event.
 */
async function pruneStaleEvents(directory: string): Promise<void> {
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
function parseEventCreationTime(name: string): number | undefined {
	const match = /^\.(\d+)-\d+-.+\.(?:json|tmp)$/.exec(name);
	if (match === null) {
		return undefined;
	}

	const createdAt = Number(match[1]);
	return Number.isFinite(createdAt) ? createdAt : undefined;
}

export async function ensureAgentEventDirectory(
	stateDirectory = resolveAgentAttentionStateDirectory()
): Promise<void> {
	await fs.mkdir(eventDirectory(stateDirectory), { recursive: true });
}

/**
 * Reads complete JSON files and consumes them from the spool.
 *
 * A malformed file is removed after the read attempt so one bad local artifact cannot keep the
 * monitor retrying forever, and an event older than EVENT_TTL_MS is consumed without being applied.
 */
export async function takeAgentEvents(
	stateDirectory = resolveAgentAttentionStateDirectory()
): Promise<{ events: AgentEvent[]; errors: Error[] }> {
	const directory = eventDirectory(stateDirectory);
	await ensureAgentEventDirectory(stateDirectory);

	const entries = await fs.readdir(directory, { withFileTypes: true });
	const eventNames = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name)
		.sort();
	const events: AgentEvent[] = [];
	const errors: Error[] = [];

	for (const name of eventNames) {
		const filePath = path.join(directory, name);
		try {
			const content = await fs.readFile(filePath, "utf8");
			const parsed: unknown = JSON.parse(content);
			const event = parseAgentEvent(parsed);
			if (event === undefined) {
				throw new Error("event spool file has an invalid shape");
			}
			if (Date.now() - Date.parse(event.timestamp) <= EVENT_TTL_MS) {
				events.push(event);
			}
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		} finally {
			await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") {
					errors.push(error);
				}
			});
		}
	}

	return { events, errors };
}

function parseAgentEvent(value: unknown): AgentEvent | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	if (
		!isUsageSource(candidate.source) ||
		typeof candidate.runtimeId !== "string" ||
		candidate.runtimeId.trim() === "" ||
		typeof candidate.cwd !== "string" ||
		candidate.cwd.trim() === "" ||
		!isAgentEventStatus(candidate.status) ||
		typeof candidate.timestamp !== "string" ||
		Number.isNaN(Date.parse(candidate.timestamp))
	) {
		return undefined;
	}

	const slot = normalizeWarpTab(candidate.slot);
	if (slot === undefined) {
		return undefined;
	}

	if (candidate.reason !== undefined && typeof candidate.reason !== "string") {
		return undefined;
	}

	return {
		source: candidate.source,
		runtimeId: candidate.runtimeId,
		slot,
		cwd: candidate.cwd,
		status: candidate.status,
		...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
		timestamp: candidate.timestamp
	};
}
