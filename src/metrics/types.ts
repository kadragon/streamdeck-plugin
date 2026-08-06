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
