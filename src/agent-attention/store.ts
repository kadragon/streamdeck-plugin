import { eventSlotKey, type AgentEvent } from "./types";
import type { UsageSource } from "../usage/types";

export type AgentAttentionSnapshot = AgentEvent;

/**
 * Keeps the newest event for each fixed source/tab slot.
 *
 * A runtime id guards against a late exit event from an older process clearing a newer process that
 * reused the same configured slot.
 */
export class AgentAttentionStore {
	readonly #slots = new Map<string, AgentEvent>();
	readonly #dismissed = new Set<string>();
	readonly #endedRuntimes = new Set<string>();

	apply(event: AgentEvent): void {
		const key = eventSlotKey(event.source, event.slot);
		const current = this.#slots.get(key);

		if (event.status !== "started" && this.#endedRuntimes.has(event.runtimeId)) {
			return;
		}

		if (current !== undefined && current.runtimeId !== event.runtimeId && isOlder(event, current)) {
			return;
		}

		if (current !== undefined && current.runtimeId === event.runtimeId && isOlder(event, current)) {
			return;
		}

		if (event.status === "exited") {
			this.#endedRuntimes.add(event.runtimeId);
			if (current?.runtimeId === event.runtimeId) {
				this.#slots.delete(key);
			}
			return;
		}

		if (event.status === "started") {
			this.#endedRuntimes.delete(event.runtimeId);
		}
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
		return this.#slots.get(key)?.status === "attention" && !this.#dismissed.has(key);
	}

	dismiss(source: UsageSource, slot: number): void {
		this.#dismissed.add(eventSlotKey(source, slot));
	}
}

function isOlder(candidate: AgentEvent, current: AgentEvent): boolean {
	return Date.parse(candidate.timestamp) < Date.parse(current.timestamp);
}
