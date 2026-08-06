import type { UsageSource } from "./usage/types";
import type { SystemMetricKind } from "./metrics/types";

export type { SystemMetricKind } from "./metrics/types";

/** Stream Deck renders key images on a square canvas; 144px matches the @2x key size. */
const SIZE = 144;

/** Widest a line of text may be before it is scaled down to fit the key. */
const TEXT_MAX_WIDTH = 126;

/**
 * Rough advance width of one character, as a fraction of the key font size.
 *
 * Only used to decide when to shrink text, so an approximation is enough — it errs on the wide side.
 */
const CHAR_WIDTH_RATIO = 0.56;

/** Colour used for the number past the alert threshold, and for a caption warning of early exhaustion. */
const DANGER_COLOR = "#FF5A5F";

/** Colour used for everything that marks a reading as no longer current. */
const STALE_COLOR = "#E0A33E";

const SYSTEM_AMBER_COLOR = "#FFB84D";
const SYSTEM_GOOD_COLOR = "#48D597";
const SYSTEM_UNAVAILABLE_COLOR = "#6B7076";
const SYSTEM_GOOD_BACKGROUND = "#14503D";
const SYSTEM_AMBER_BACKGROUND = "#5A3D14";
const SYSTEM_DANGER_BACKGROUND = "#5A1F2C";
const SYSTEM_UNAVAILABLE_BACKGROUND = "#202D3B";
const SYSTEM_MIN_PERCENT = 0;
const SYSTEM_MAX_PERCENT = 100;

/**
 * Value that fills the gauge completely, per metric.
 *
 * Percent-native metrics are full at 100. Network and GPU power have no intrinsic ceiling, so these
 * are display conventions rather than machine properties — one table so a rescale is one edit.
 */
const SYSTEM_METRIC_FULL_SCALE: Record<SystemMetricKind, number> = {
	cpu: SYSTEM_MAX_PERCENT,
	gpu: SYSTEM_MAX_PERCENT,
	memory: SYSTEM_MAX_PERCENT,
	disk: SYSTEM_MAX_PERCENT,
	network: 1_000,
	"gpu-memory": SYSTEM_MAX_PERCENT,
	"gpu-power": 500
};

const SYSTEM_MIN_TEMPERATURE_C = -50;
const SYSTEM_MAX_TEMPERATURE_C = 150;
const SYSTEM_NEUTRAL_BACKGROUND = "#172235";
const SYSTEM_NEUTRAL_COLOR = "#5E8CFF";

/**
 * Fixed vertical rhythm of the System Monitor key face: header, value, gauge, footer.
 *
 * The rows are constants rather than inline numbers because the four bands must stay clear of each
 * other at every text size the auto-fit can produce.
 */
const SYSTEM_HEADER_BASELINE = 44;
const SYSTEM_VALUE_BASELINE = 92;
const SYSTEM_GAUGE_X = 22;
const SYSTEM_GAUGE_Y = 104;
const SYSTEM_GAUGE_WIDTH = 100;
const SYSTEM_GAUGE_HEIGHT = 9;
/** A reading of exactly zero still draws this much fill, so it cannot be mistaken for no reading. */
const SYSTEM_GAUGE_MIN_FILL = 3;
const SYSTEM_FOOTER_BASELINE = 131;

/** Font used by key faces whose text is part of the rendered SVG rather than Stream Deck's title layer. */
const KEY_FONT_FAMILY = "Segoe UI, Helvetica, Arial, sans-serif";

/**
 * Per-source branding for the key face; the accent colour is what tells the two keys apart at a glance.
 *
 * With no border on the face, the backdrop tint is the only thing carrying the brand besides the text,
 * so it is a touch stronger than a plain dark grey would be.
 */
const BRANDS: Record<UsageSource, { label: string; accent: string; backdrop: string }> = {
	claude: { label: "CLAUDE", accent: "#D97757", backdrop: "#24160F" },
	codex: { label: "CODEX", accent: "#10A37F", backdrop: "#0D2019" }
};

/**
 * Everything the key face needs to draw one reading.
 */
export type KeyFace = {
	source: UsageSource;
	/** Percentage of the weekly allowance consumed, or `undefined` when no reading is available. */
	usedPercent?: number;
	/** Small caption under the percentage, e.g. a reset countdown or how old the reading is. */
	caption?: string;
	/** Marks the reading as no longer current: dims the number and switches the caption to amber. */
	stale?: boolean;
	/** Past the alert threshold; turns the number red. */
	danger?: boolean;
	/** The caption is a warning rather than a plain countdown; turns it red. */
	warn?: boolean;
};

export type WarpTabKeyFace = {
	/** Selected filename stem, or `undefined` while the property inspector has no selection. */
	label?: string;
};

export type SystemMonitorFace = {
	metric: SystemMetricKind;
	value?: number;
	unit?: "percent" | "mbps" | "watts";
	usagePercent?: number;
	temperatureC?: number;
	status?: "ready" | "missing" | "stale" | "unsupported";
	/** Which NVIDIA GPU the reading came from; shown in the header only when it is not the default. */
	gpuIndex?: number;
};

/**
 * Builds the key image as an inline SVG data URI.
 */
export function renderKey(face: KeyFace): string {
	const { usedPercent } = face;
	const hasReading = usedPercent !== undefined;
	const clamped = Math.min(100, Math.max(0, usedPercent ?? 0));
	const brand = BRANDS[face.source];

	// The brand accent stays on the label even in the danger state, so the key remains identifiable as
	// Claude or Codex while the number itself does the warning.
	const numberColor = !hasReading ? "#6b7076" : face.danger ? DANGER_COLOR : brand.accent;
	const captionColor = face.stale ? STALE_COLOR : face.warn ? DANGER_COLOR : "#9aa0a8";

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" fill="${brand.backdrop}"/>
<g font-family="${KEY_FONT_FAMILY}" text-anchor="middle">
<text x="72" y="34" fill="${brand.accent}" font-size="19" font-weight="700" letter-spacing="2" opacity="${face.stale ? 0.6 : 1}">${escapeText(brand.label)}</text>
${face.stale ? `<circle cx="129" cy="24" r="4.5" fill="${STALE_COLOR}"/>` : ""}
${renderValue(hasReading, clamped, numberColor, face.stale === true)}
${renderCaption(face.caption ?? "", captionColor)}
</g>
</svg>`;

	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

/** Builds a deterministic, local-only key face for the Windows System Monitor action. */
export function renderSystemMonitor(face: SystemMonitorFace): string {
	const value = face.value ?? face.usagePercent;
	const usageColor = isSystemValue(face.metric, value) ? "#F2F4F7" : SYSTEM_UNAVAILABLE_COLOR;
	const temperature = temperaturePalette(face.temperatureC, face.metric, face.status);
	const headerLabel = systemHeaderLabel(face.metric, face.gpuIndex);

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" fill="${temperature.background}"/>
<rect x="8" y="8" width="128" height="128" rx="14" fill="#0B1220" opacity="0.52" stroke="${temperature.accent}" stroke-width="2"/>
<g font-family="${KEY_FONT_FAMILY}">
<text x="72" y="${SYSTEM_HEADER_BASELINE}" fill="#F2F4F7" font-size="${fitFontSize(headerLabel.length, 21, 13)}" font-weight="700" text-anchor="middle" letter-spacing="1.2">${escapeText(headerLabel)}</text>
${renderSystemValue(face.metric, value, face.unit, usageColor)}
${renderSystemGauge(face.metric, value, temperature.accent)}
${renderSystemStatus(face.status)}
${renderSystemTemperature(face.metric, face.temperatureC, face.status)}
</g>
</svg>`;

	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

/** Builds a Warp Tab Config key face with its label positioned inside the artwork. */
export function renderWarpTabKey(face: WarpTabKeyFace): string {
	const lines = splitWarpTabLabel(face.label);
	const longestLine = Math.max(...lines.map((line) => line.length));
	const labelSize = fitFontSize(longestLine, 16, 9);
	const labelMarkup = lines
		.map((line, index) => `<text x="72" y="${lines.length === 1 ? 123 : 114 + index * 17}" fill="#F2F4F7" font-size="${labelSize}" font-weight="700" letter-spacing="0.8">${escapeText(line)}</text>`)
		.join("\n");

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" fill="#0B1220"/>
<g stroke-linejoin="round">
<rect x="11" y="15" width="96" height="72" rx="8" fill="#13213A" stroke="#2B67D1" stroke-width="2" opacity="0.78"/>
<rect x="23" y="23" width="108" height="75" rx="8" fill="#122033" stroke="#39D5FF" stroke-width="2"/>
<path d="M23 42H131" stroke="#29415D" stroke-width="2"/>
<circle cx="36" cy="32" r="3" fill="#FFB84D"/>
<circle cx="46" cy="32" r="3" fill="#5EE6FF"/>
<circle cx="56" cy="32" r="3" fill="#2B67D1"/>
<path d="M42 61L51 68L42 75" fill="none" stroke="#5EE6FF" stroke-width="4"/>
<path d="M57 75H75" stroke="#FFB84D" stroke-width="4"/>
</g>
<g font-family="${KEY_FONT_FAMILY}" text-anchor="middle">
<text x="72" y="93" fill="#7E9DBA" font-size="10" font-weight="600" letter-spacing="1.5">WARP TAB</text>
${labelMarkup}
</g>
</svg>`;

	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

function splitWarpTabLabel(value: string | undefined): string[] {
	const normalized = value?.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toUpperCase() || "SELECT CONFIG";
	const words = normalized.split(" ");
	if (words.length <= 1) {
		return [normalized];
	}

	const lines: string[] = [];
	let current = words[0] ?? normalized;
	for (const word of words.slice(1)) {
		const candidate = `${current} ${word}`;
		if (candidate.length <= 14 || lines.length > 0) {
			current = candidate;
			continue;
		}

		lines.push(current);
		current = word;
	}

	if (current !== "") {
		lines.push(current);
	}

	return lines.length > 0 ? lines : [normalized];
}

/**
 * Draws the percentage, or a question mark when there is nothing to show.
 *
 * A dashed placeholder reads as a number at key size, so the no-data case gets a glyph that cannot be
 * mistaken for a value.
 */
function renderValue(hasReading: boolean, percent: number, color: string, stale: boolean): string {
	const opacity = stale ? 0.6 : 1;

	if (!hasReading) {
		return `<text x="72" y="97" fill="${color}" font-size="62" font-weight="700" opacity="${opacity}">?</text>`;
	}

	const digits = `${Math.round(percent)}`;
	// The "%" sign rides along at 45% of the number's size, so both shrink together on a 3-digit value.
	const size = fitFontSize(digits.length + 0.45, 66, 44);

	return `<text x="72" y="97" fill="${color}" font-size="${size}" font-weight="700" opacity="${opacity}" style="font-variant-numeric:tabular-nums" font-feature-settings="'tnum'">${escapeText(digits)}<tspan font-size="${round(size * 0.45)}" dy="-3">%</tspan></text>`;
}

/**
 * Draws the caption, shrinking it when the text would otherwise run past the edge of the key.
 */
function renderCaption(caption: string, color: string): string {
	if (caption === "") {
		return "";
	}

	const size = fitFontSize(caption.length, 21, 15);

	return `<text x="72" y="128" fill="${color}" font-size="${size}" font-weight="600" style="font-variant-numeric:tabular-nums" font-feature-settings="'tnum'">${escapeText(caption)}</text>`;
}

/**
 * Scales a font size down until the given number of characters fits within {@link TEXT_MAX_WIDTH}.
 */
function fitFontSize(charCount: number, preferred: number, minimum: number): number {
	const width = charCount * CHAR_WIDTH_RATIO * preferred;
	if (width <= TEXT_MAX_WIDTH) {
		return preferred;
	}

	return round(Math.max(minimum, (preferred * TEXT_MAX_WIDTH) / width));
}

/**
 * Formats a reset time as a compact countdown, e.g. `3d 4h` or `52m`.
 */
export function formatCountdown(resetsAt: Date, now: Date): string {
	const minutes = Math.max(0, Math.round((resetsAt.getTime() - now.getTime()) / 60_000));
	if (minutes < 60) {
		return `${minutes}m`;
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h ${minutes % 60}m`;
	}

	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

export function formatSystemMetric(metric: SystemMetricKind, value: number | undefined, unit?: SystemMonitorFace["unit"]): string {
	if (!isSystemValue(metric, value)) {
		return "--";
	}

	if (unit === "mbps" || metric === "network") {
		return `${formatDecimal(value)} Mbps`;
	}
	if (unit === "watts" || metric === "gpu-power") {
		return `${formatDecimal(value)} W`;
	}

	return `${Math.round(value)}%`;
}

export function systemMetricProgress(metric: SystemMetricKind, value: number | undefined): number | undefined {
	if (!isSystemValue(metric, value)) {
		return undefined;
	}

	return Math.max(0, Math.min(100, (value / SYSTEM_METRIC_FULL_SCALE[metric]) * 100));
}

function isSystemValue(metric: SystemMetricKind, value: number | undefined): value is number {
	if (metric === "network") {
		return isInRange(value, 0, 100_000);
	}
	if (metric === "gpu-power") {
		return isInRange(value, 0, 2_000);
	}

	return isInRange(value, SYSTEM_MIN_PERCENT, SYSTEM_MAX_PERCENT);
}

function isSystemTemperature(value: number | undefined): value is number {
	return isInRange(value, SYSTEM_MIN_TEMPERATURE_C, SYSTEM_MAX_TEMPERATURE_C);
}

function isInRange(value: number | undefined, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function renderSystemValue(metric: SystemMetricKind, value: number | undefined, unit: SystemMonitorFace["unit"], color: string): string {
	const formatted = formatSystemMetric(metric, value, unit);
	const size = fitFontSize(formatted.length, 44, 24);
	return `<text x="72" y="${SYSTEM_VALUE_BASELINE}" fill="${color}" font-size="${size}" font-weight="700" text-anchor="middle" style="font-variant-numeric:tabular-nums" font-feature-settings="'tnum'">${escapeText(formatted)}</text>`;
}

/**
 * Draws the magnitude gauge: a track that is always present, and a fill only when there is a reading.
 *
 * A genuine zero still gets a minimum-width nub so it stays distinguishable from a missing reading,
 * which draws no fill at all.
 */
function renderSystemGauge(metric: SystemMetricKind, value: number | undefined, accent: string): string {
	const track = `<rect x="${SYSTEM_GAUGE_X}" y="${SYSTEM_GAUGE_Y}" width="${SYSTEM_GAUGE_WIDTH}" height="${SYSTEM_GAUGE_HEIGHT}" rx="${SYSTEM_GAUGE_HEIGHT / 2}" fill="#0B1220" stroke="#2A3A55" stroke-width="1"/>`;
	const progress = systemMetricProgress(metric, value);
	if (progress === undefined) {
		return track;
	}

	const width = Math.max(SYSTEM_GAUGE_MIN_FILL, round((progress / 100) * SYSTEM_GAUGE_WIDTH));
	return `${track}
<rect x="${SYSTEM_GAUGE_X}" y="${SYSTEM_GAUGE_Y}" width="${width}" height="${SYSTEM_GAUGE_HEIGHT}" rx="${SYSTEM_GAUGE_HEIGHT / 2}" fill="${accent}"/>`;
}

/** Draws the measured temperature as a chip, on the metrics that carry one. */
function renderSystemTemperature(metric: SystemMetricKind, value: number | undefined, status: SystemMonitorFace["status"]): string {
	if (!hasTemperatureChannel(metric) || status === "unsupported" || !isSystemTemperature(value)) {
		return "";
	}

	return `<text x="130" y="${SYSTEM_FOOTER_BASELINE}" fill="${temperatureColor(value)}" font-size="14" font-weight="700" text-anchor="end" style="font-variant-numeric:tabular-nums" font-feature-settings="'tnum'">${Math.round(value)}&#176;</text>`;
}

/** The metrics whose reading is accompanied by a temperature sensor. */
function hasTemperatureChannel(metric: SystemMetricKind): boolean {
	return metric === "cpu" || metric === "gpu";
}

function temperatureColor(value: number): string {
	return value >= 80 ? DANGER_COLOR : value >= 60 ? SYSTEM_AMBER_COLOR : SYSTEM_GOOD_COLOR;
}

function temperaturePalette(value: number | undefined, metric: SystemMetricKind, status: SystemMonitorFace["status"]): { background: string; accent: string } {
	if (!hasTemperatureChannel(metric)) {
		return { background: SYSTEM_NEUTRAL_BACKGROUND, accent: status === "unsupported" ? SYSTEM_UNAVAILABLE_COLOR : SYSTEM_NEUTRAL_COLOR };
	}
	if (!isSystemTemperature(value) || status === "unsupported") {
		return { background: SYSTEM_UNAVAILABLE_BACKGROUND, accent: SYSTEM_UNAVAILABLE_COLOR };
	}

	if (value >= 80) {
		return { background: SYSTEM_DANGER_BACKGROUND, accent: DANGER_COLOR };
	}

	if (value >= 60) {
		return { background: SYSTEM_AMBER_BACKGROUND, accent: SYSTEM_AMBER_COLOR };
	}

	return { background: SYSTEM_GOOD_BACKGROUND, accent: SYSTEM_GOOD_COLOR };
}

function renderSystemStatus(status: SystemMonitorFace["status"]): string {
	if (status === undefined || status === "ready") {
		return "";
	}

	const label = status === "unsupported" ? "UNSUPPORTED" : status === "stale" ? "STALE" : "NO DATA";
	const color = status === "stale" ? STALE_COLOR : SYSTEM_UNAVAILABLE_COLOR;
	return `<text x="14" y="${SYSTEM_FOOTER_BASELINE}" fill="${color}" font-size="11" font-weight="600" text-anchor="start" letter-spacing="1">${label}</text>`;
}

/** Header text: the metric name, plus the GPU index when it is not the default one. */
function systemHeaderLabel(metric: SystemMetricKind, gpuIndex: number | undefined): string {
	const label = systemMetricLabel(metric);
	if (!isGpuScoped(metric) || typeof gpuIndex !== "number" || !Number.isInteger(gpuIndex) || gpuIndex <= 0) {
		return label;
	}

	return `${label} #${gpuIndex}`;
}

function isGpuScoped(metric: SystemMetricKind): boolean {
	return metric === "gpu" || metric === "gpu-memory" || metric === "gpu-power";
}

function systemMetricLabel(metric: SystemMetricKind): string {
	const labels: Record<SystemMetricKind, string> = {
		cpu: "CPU",
		gpu: "GPU",
		memory: "RAM",
		disk: "DISK",
		network: "NETWORK",
		"gpu-memory": "GPU MEM",
		"gpu-power": "GPU POWER"
	};
	return labels[metric];
}

function formatDecimal(value: number): string {
	const rounded = Math.round(value * 10) / 10;
	return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}

/**
 * Escapes the characters that would otherwise break out of an SVG text node.
 */
function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
