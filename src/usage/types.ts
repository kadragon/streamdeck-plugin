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
