export type SystemMetricKind = "cpu" | "gpu" | "memory" | "disk" | "network" | "gpu-memory" | "gpu-power";

export const SYSTEM_METRIC_KINDS: readonly SystemMetricKind[] = [
	"cpu",
	"gpu",
	"memory",
	"disk",
	"network",
	"gpu-memory",
	"gpu-power"
];

export function isSystemMetricKind(value: unknown): value is SystemMetricKind {
	return typeof value === "string" && (SYSTEM_METRIC_KINDS as readonly string[]).includes(value);
}

/**
 * Canonical form of a drive identifier, ignoring case and the trailing separator Windows tools add.
 *
 * It lives here, in the module with no Node dependencies, because both the sampler that picks which
 * drive to read and the renderer that prints the drive name must agree: two copies that drift would
 * let a key show one drive's name over another drive's percentage.
 */
export function normalizeDiskDrive(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim().replace(/[\\/]+$/, "").toUpperCase();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Steps through {@link SYSTEM_METRIC_KINDS}, which is the order the Property Inspector offers.
 *
 * The list wraps in both directions so a dial never stops at an end, and an unrecognized current
 * metric falls back to the first entry rather than leaving the dial stuck.
 */
export function stepSystemMetric(current: unknown, steps: number): SystemMetricKind {
	const length = SYSTEM_METRIC_KINDS.length;
	const index = isSystemMetricKind(current) ? SYSTEM_METRIC_KINDS.indexOf(current) : 0;
	const offset = Number.isFinite(steps) ? Math.trunc(steps) : 0;
	return SYSTEM_METRIC_KINDS[(((index + offset) % length) + length) % length] as SystemMetricKind;
}
