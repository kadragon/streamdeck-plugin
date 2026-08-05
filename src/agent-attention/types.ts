import type { UsageSource } from "../usage/types";

export const MIN_WARP_TAB = 1;
export const MAX_WARP_TAB = 8;

export type AgentEventStatus = "started" | "running" | "attention" | "exited";

/**
 * The complete event payload written to the local spool.
 *
 * Keep this contract deliberately small: hook input may contain prompts, messages, and tool data,
 * none of which belongs in the Stream Deck state channel.
 */
export type AgentEvent = {
	source: UsageSource;
	runtimeId: string;
	slot: number;
	cwd: string;
	status: AgentEventStatus;
	reason?: string;
	timestamp: string;
};

export function isUsageSource(value: unknown): value is UsageSource {
	return value === "claude" || value === "codex";
}

export function normalizeUsageSource(value: unknown): UsageSource | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const source = value.trim().toLowerCase();
	return isUsageSource(source) ? source : undefined;
}

export function normalizeWarpTab(value: unknown): number | undefined {
	if (typeof value === "boolean" || value === null || value === undefined) {
		return undefined;
	}

	const slot = typeof value === "number" ? value : Number(String(value).trim());
	if (!Number.isInteger(slot) || slot < MIN_WARP_TAB || slot > MAX_WARP_TAB) {
		return undefined;
	}

	return slot;
}

export function isAgentEventStatus(value: unknown): value is AgentEventStatus {
	return value === "started" || value === "running" || value === "attention" || value === "exited";
}

export function eventSlotKey(source: UsageSource, slot: number): string {
	return source + ":" + slot;
}
