import type { UsageSource } from "./usage/types";

/** Stream Deck renders key images on a square canvas; 144px matches the @2x key size. */
const SIZE = 144;

/** Widest a line of text may be before it is scaled down to fit the key. */
const TEXT_MAX_WIDTH = 126;

/**
 * Rough advance width of one character, as a fraction of the font size, for Helvetica/Arial Bold.
 *
 * Only used to decide when to shrink text, so an approximation is enough — it errs on the wide side.
 */
const CHAR_WIDTH_RATIO = 0.56;

/** Colour used for the number past the alert threshold, and for a caption warning of early exhaustion. */
const DANGER_COLOR = "#FF5A5F";

/** Colour used for everything that marks a reading as no longer current. */
const STALE_COLOR = "#E0A33E";

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
<g font-family="Helvetica, Arial, sans-serif" text-anchor="middle">
<text x="72" y="34" fill="${brand.accent}" font-size="19" font-weight="700" letter-spacing="2" opacity="${face.stale ? 0.6 : 1}">${escapeText(brand.label)}</text>
${face.stale ? `<circle cx="129" cy="24" r="4.5" fill="${STALE_COLOR}"/>` : ""}
${renderValue(hasReading, clamped, numberColor, face.stale === true)}
${renderCaption(face.caption ?? "", captionColor)}
</g>
</svg>`;

	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
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

/**
 * Escapes the characters that would otherwise break out of an SVG text node.
 */
function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
