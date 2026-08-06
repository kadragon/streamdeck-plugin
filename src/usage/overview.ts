import type { BurnProjection } from "./burn-rate";
import { isUsagePercent, isUsableDate, type UsageReading, type UsageSource } from "./types";

export type UsageOverviewMode = "used" | "remaining" | "burn" | "reset";

export const USAGE_OVERVIEW_MODES: readonly UsageOverviewMode[] = ["used", "remaining", "burn", "reset"];
export const OVERVIEW_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export type OverviewProvider = {
	source: UsageSource;
	reading?: UsageReading;
	burn?: BurnProjection;
};

export type OverviewMetric = {
	text: string;
	progress?: number;
	state: "ready" | "stale" | "warning" | "missing";
	detail?: "missing" | "no-burn" | "no-reset";
};

export function normalizeUsageOverviewMode(value: unknown): UsageOverviewMode {
	return isUsageOverviewMode(value) ? value : "used";
}

export function nextUsageOverviewMode(value: unknown): UsageOverviewMode {
	const current = normalizeUsageOverviewMode(value);
	const index = USAGE_OVERVIEW_MODES.indexOf(current);
	return USAGE_OVERVIEW_MODES[(index + 1) % USAGE_OVERVIEW_MODES.length] ?? "used";
}

/** Converts one provider reading into the value shown for the selected overview mode. */
export function getOverviewMetric(
	provider: OverviewProvider,
	mode: UsageOverviewMode,
	now: Date,
	alertPercent = 90
): OverviewMetric {
	const reading = provider.reading;
	if (reading === undefined || !isUsableDate(reading.observedAt) || !isUsagePercent(reading.usedPercent)) {
		return { text: "--", state: "missing", detail: "missing" };
	}

	const stale = !isUsableDate(now) || now.getTime() - reading.observedAt.getTime() > OVERVIEW_STALE_AFTER_MS;
	const warning = reading.usedPercent >= alertPercent || willExhaustBeforeReset(provider.burn, reading.resetsAt);

	switch (mode) {
		case "used":
			return {
				text: formatPercent(reading.usedPercent),
				progress: reading.usedPercent,
				state: stale ? "stale" : warning ? "warning" : "ready"
			};
		case "remaining": {
				const remaining = 100 - reading.usedPercent;
				return {
					text: formatPercent(remaining),
					progress: remaining,
					state: stale ? "stale" : warning ? "warning" : "ready"
				};
			}
		case "burn":
			if (provider.burn === undefined || !Number.isFinite(provider.burn.percentPerHour)) {
				return { text: "--", state: stale ? "stale" : "missing", detail: "no-burn" };
			}

			return {
				text: `${formatNumber(provider.burn.percentPerHour)}%/h`,
				progress: clampPercent(provider.burn.percentPerHour),
				state: stale ? "stale" : warning ? "warning" : "ready"
			};
		case "reset":
			if (!isUsableDate(reading.resetsAt)) {
				return { text: "--", state: stale ? "stale" : "missing", detail: "no-reset" };
			}

			return {
				text: formatCountdown(reading.resetsAt, now),
				state: stale ? "stale" : "ready"
			};
	}
}

function isUsageOverviewMode(value: unknown): value is UsageOverviewMode {
	return typeof value === "string" && (USAGE_OVERVIEW_MODES as readonly string[]).includes(value);
}

function willExhaustBeforeReset(burn: BurnProjection | undefined, resetsAt: Date | undefined): boolean {
	return burn !== undefined && isUsableDate(resetsAt) && isUsableDate(burn.exhaustsAt) && burn.exhaustsAt.getTime() < resetsAt.getTime();
}

function formatPercent(value: number): string {
	return `${formatNumber(value)}%`;
}

function formatNumber(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function formatCountdown(target: Date, now: Date): string {
	const minutes = Math.max(0, Math.round((target.getTime() - now.getTime()) / 60_000));
	if (minutes < 60) {
		return `${minutes}m`;
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ${minutes % 60}m`;
	}

	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
