import { eventSlotKey, type AgentEvent } from "./types";
import type { UsageSource } from "../usage/types";

export type AgentAttentionSnapshot = AgentEvent;

/**
 * How long an exited runtime keeps rejecting older events before its entry is forgotten.
 *
 * The entry only guards against an out-of-order event that was written before the exit, so a few
 * minutes is ample and keeps the map bounded in a plugin process that runs for weeks.
 */
const ENDED_RUNTIME_TTL_MS = 10 * 60 * 1000;

/**
 * Keeps the newest event for each fixed source/tab slot.
 *
 * A runtime id guards against a late exit event from an older process clearing a newer process that
 * reused the same configured slot. The guard is by exit timestamp rather than by identity alone, so
 * a session that ends and restarts under the same runtime id (Claude Code fires SessionEnd on
 * `/clear`) is not blacklisted for the rest of the wrapped process.
 */
export class AgentAttentionStore {
	readonly #slots = new Map<string, AgentEvent>();
	readonly #dismissed = new Map<string, number>();
	readonly #endedRuntimes = new Map<string, number>();

	apply(event: AgentEvent): void {
		const key = eventSlotKey(event.source, event.slot);
		const current = this.#slots.get(key);
		const eventTime = Date.parse(event.timestamp);

		const endedAt = this.#endedRuntimes.get(event.runtimeId);
		if (endedAt !== undefined && eventTime <= endedAt) {
			return;
		}

		if (current !== undefined && isOlder(event, current)) {
			return;
		}

		if (event.status === "exited") {
			this.#endedRuntimes.set(event.runtimeId, eventTime);
			this.#pruneEndedRuntimes(eventTime);
			if (current?.runtimeId === event.runtimeId) {
				this.#slots.delete(key);
				this.#dismissed.delete(key);
			}
			return;
		}

		this.#endedRuntimes.delete(event.runtimeId);
		this.#slots.set(key, event);
		if (event.status === "started" || event.status === "running") {
			this.#dismissed.delete(key);
		}
	}

	snapshot(source: UsageSource, slot: number): AgentAttentionSnapshot | undefined {
		return this.#slots.get(eventSlotKey(source, slot));
	}

	isAttentionVisible(source: UsageSource, slot: number): boolean {
		const key = eventSlotKey(source, slot);
		const current = this.#slots.get(key);
		if (current?.status !== "attention") {
			return false;
		}

		const dismissedAt = this.#dismissed.get(key);
		return dismissedAt === undefined || Date.parse(current.timestamp) > dismissedAt;
	}

	/**
	 * Silences the slot's current event only.
	 *
	 * The dismissal is recorded against that event's timestamp so a later attention event — a second
	 * permission prompt with no tool call in between — still blinks.
	 */
	dismiss(source: UsageSource, slot: number): void {
		const key = eventSlotKey(source, slot);
		const current = this.#slots.get(key);
		this.#dismissed.set(key, current === undefined ? Date.now() : Date.parse(current.timestamp));
	}

	#pruneEndedRuntimes(now: number): void {
		for (const [runtimeId, endedAt] of this.#endedRuntimes) {
			if (now - endedAt > ENDED_RUNTIME_TTL_MS) {
				this.#endedRuntimes.delete(runtimeId);
			}
		}
	}
}

function isOlder(candidate: AgentEvent, current: AgentEvent): boolean {
	return Date.parse(candidate.timestamp) < Date.parse(current.timestamp);
}
