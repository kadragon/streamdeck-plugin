import type { UsageSource } from "./usage/types";
import type { SystemMetricKind } from "./metrics/types";
import type { OverviewMetric, UsageOverviewMode } from "./usage/overview";

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
const SYSTEM_MIN_TEMPERATURE_C = -50;
const SYSTEM_MAX_TEMPERATURE_C = 150;

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
};

export type UsageOverviewProviderFace = OverviewMetric & {
	source: UsageSource;
};

export type UsageOverviewFace = {
	mode: UsageOverviewMode;
	claude: UsageOverviewProviderFace;
	codex: UsageOverviewProviderFace;
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
	const metricLabel = systemMetricLabel(face.metric);
	const value = face.value ?? face.usagePercent;
	const usageColor = isSystemValue(face.metric, value) ? "#F2F4F7" : SYSTEM_UNAVAILABLE_COLOR;
	const temperature = temperaturePalette(face.temperatureC, face.metric, face.status);
	const usageMarkup = renderSystemValue(face.metric, value, face.unit, usageColor);
	const statusMarkup = renderSystemStatus(face.status);

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" fill="${temperature.background}"/>
<rect x="8" y="8" width="128" height="128" rx="14" fill="#0B1220" opacity="0.52" stroke="${temperature.accent}" stroke-width="2"/>
<g font-family="${KEY_FONT_FAMILY}" text-anchor="middle">
<text x="72" y="55" fill="#F2F4F7" font-size="22" font-weight="700" letter-spacing="1.5">${escapeText(metricLabel)}</text>
${usageMarkup}
${statusMarkup}
</g>
</svg>`;

	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

/** Builds the two-provider face used by the AI Usage Overview action. */
export function renderUsageOverview(face: UsageOverviewFace): string {
	const modeLabel = face.mode.toUpperCase();
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<rect width="${SIZE}" height="${SIZE}" fill="#0B1220"/>
<g font-family="${KEY_FONT_FAMILY}">
<text x="72" y="22" fill="#F2F4F7" font-size="13" font-weight="700" text-anchor="middle" letter-spacing="1.2">AI USAGE / ${escapeText(modeLabel)}</text>
${renderOverviewRow(face.claude, 62)}
${renderOverviewRow(face.codex, 103)}
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

	const maximum = metric === "network" ? 1_000 : metric === "gpu-power" ? 500 : SYSTEM_MAX_PERCENT;
	return Math.max(0, Math.min(100, (value / maximum) * 100));
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
	const size = fitFontSize(formatted.length, 48, 28);
	return `<text x="72" y="112" fill="${color}" font-size="${size}" font-weight="700" style="font-variant-numeric:tabular-nums" font-feature-settings="'tnum'">${escapeText(formatted)}</text>`;
}

function temperaturePalette(value: number | undefined, metric: SystemMetricKind, status: SystemMonitorFace["status"]): { background: string; accent: string } {
	if (metric !== "cpu" && metric !== "gpu") {
		return { background: "#172235", accent: status === "unsupported" ? SYSTEM_UNAVAILABLE_COLOR : "#5E8CFF" };
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
	return `<text x="72" y="132" fill="${color}" font-size="11" font-weight="600" letter-spacing="1">${label}</text>`;
}

/**
 * Colour for one Usage Overview provider row.
 *
 * Shared by the key SVG and the Stream Deck+ dial feedback so the two faces cannot drift apart.
 */
export function overviewStateColor(provider: UsageOverviewProviderFace): string {
	const brand = BRANDS[provider.source];
	return provider.state === "warning" ? DANGER_COLOR : provider.state === "stale" ? STALE_COLOR : provider.state === "ready" ? brand.accent : SYSTEM_UNAVAILABLE_COLOR;
}

/** Short status caption for one provider row, or `""` when the reading needs no annotation. */
export function overviewDetailLabel(provider: UsageOverviewProviderFace): string {
	return provider.state === "stale" ? "STALE" : provider.detail === "no-burn" ? "NO RATE" : provider.detail === "no-reset" ? "NO RESET" : provider.state === "missing" ? "NO DATA" : "";
}

/** Brand accent colour for one usage source, used for the provider label on both faces. */
export function overviewBrandAccent(source: UsageSource): string {
	return BRANDS[source].accent;
}

function renderOverviewRow(provider: UsageOverviewProviderFace, y: number): string {
	const brand = BRANDS[provider.source];
	const color = overviewStateColor(provider);
	const detail = overviewDetailLabel(provider);
	return `<line x1="10" y1="${y + 9}" x2="134" y2="${y + 9}" stroke="#22304A" stroke-width="1"/>
<text x="14" y="${y}" fill="${brand.accent}" font-size="13" font-weight="700" letter-spacing="1">${escapeText(provider.source.toUpperCase())}</text>
<text x="130" y="${y}" fill="${color}" font-size="22" font-weight="700" text-anchor="end" style="font-variant-numeric:tabular-nums">${escapeText(provider.text)}</text>
${detail === "" ? "" : `<text x="14" y="${y + 16}" fill="${color}" font-size="9" font-weight="600" letter-spacing="0.8">${detail}</text>`}`;
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
