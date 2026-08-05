import type { UsageReading, UsageSample } from "./types";

/** Two observations closer together than this say little about the trend, so they are not used. */
const MIN_SPAN_MS = 10 * 60 * 1000;

/** Below this rise the readings are indistinguishable from rounding noise. */
const MIN_RISE_PERCENT = 0.5;

/**
 * An estimate of when the weekly allowance runs out at the recent rate of consumption.
 */
export type BurnProjection = {
	exhaustsAt: Date;
	/** Percentage points consumed per hour over the samples used for the estimate. */
	percentPerHour: number;
};

/**
 * Estimates when the allowance will be exhausted, or `undefined` when the samples cannot support one.
 *
 * Only samples since the last window reset are considered: a percentage that drops means the window
 * rolled over, and averaging across that boundary would understate the current rate.
 */
export function projectExhaustion(reading: UsageReading, now: Date): BurnProjection | undefined {
	const samples = currentWindowSamples([...reading.history, { at: reading.observedAt, usedPercent: reading.usedPercent }]);
	if (samples.length < 2) {
		return undefined;
	}

	const first = samples[0];
	const last = samples[samples.length - 1];
	const spanMs = last.at.getTime() - first.at.getTime();
	const rise = last.usedPercent - first.usedPercent;

	if (spanMs < MIN_SPAN_MS || rise < MIN_RISE_PERCENT) {
		return undefined;
	}

	const percentPerHour = rise / (spanMs / 3_600_000);
	const remaining = Math.max(0, 100 - last.usedPercent);

	return {
		exhaustsAt: new Date(now.getTime() + (remaining / percentPerHour) * 3_600_000),
		percentPerHour
	};
}

/**
 * Keeps only the trailing run of samples that never decreases, i.e. everything since the last reset.
 */
export function currentWindowSamples(samples: UsageSample[]): UsageSample[] {
	const sorted = [...samples].sort((a, b) => a.at.getTime() - b.at.getTime());

	let start = 0;
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i].usedPercent < sorted[i - 1].usedPercent) {
			start = i;
		}
	}

	return sorted.slice(start);
}
