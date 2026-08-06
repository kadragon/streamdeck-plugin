/**
 * The tools whose weekly rate-limit usage this plugin can report.
 */
export type UsageSource = "claude" | "codex";

/**
 * One observation of the weekly percentage at a point in time.
 */
export type UsageSample = {
	at: Date;
	usedPercent: number;
};

export const MIN_USAGE_PERCENT = 0;
export const MAX_USAGE_PERCENT = 100;

/** Returns true only for a percentage that can safely be shown as quota usage. */
export function isUsagePercent(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= MIN_USAGE_PERCENT && value <= MAX_USAGE_PERCENT;
}

/** Parses a source timestamp without inventing a current time for malformed input. */
export function parseUsageTimestamp(value: unknown): Date | undefined {
	if (value instanceof Date) {
		return isUsableDate(value) ? new Date(value.getTime()) : undefined;
	}

	if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && value.trim() === "")) {
		return undefined;
	}

	const parsed = new Date(value);
	return isUsableDate(parsed) ? parsed : undefined;
}

/** Parses a reset timestamp, whose numeric source representation is epoch seconds. */
export function parseResetTimestamp(value: unknown): Date | undefined {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			return undefined;
		}

		const parsed = new Date(value * 1000);
		return isUsableDate(parsed) ? parsed : undefined;
	}

	return parseUsageTimestamp(value);
}

export function isUsableDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

/** Keeps invalid samples out of burn-rate history even when a caller supplies an untrusted object. */
export function normalizeUsageSample(value: unknown): UsageSample | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const sample = value as { at?: unknown; usedPercent?: unknown };
	const at = parseUsageTimestamp(sample.at);
	if (at === undefined || !isUsagePercent(sample.usedPercent)) {
		return undefined;
	}

	return { at, usedPercent: sample.usedPercent };
}

/**
 * A weekly rate-limit reading, as last observed by the source tool itself.
 *
 * Both sources report the percentage the *tool* saw the last time it talked to its API, so
 * {@link UsageReading.observedAt} matters: a reading from three days ago is stale, not current.
 */
export type UsageReading = {
	/** Percentage of the weekly allowance consumed, 0-100. */
	usedPercent: number;
	/** When the weekly window resets, or `undefined` when the source did not report it. */
	resetsAt?: Date;
	/** When the source tool recorded this reading. */
	observedAt: Date;
	/** Earlier observations, oldest first, used to estimate the burn rate. May be empty. */
	history: UsageSample[];
};

/**
 * Raised when a source has no usable reading, e.g. the tool has not run recently enough to leave one.
 */
export class NoUsageDataError extends Error {}
