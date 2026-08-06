import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const TAB_CONFIG_EXTENSION = ".toml";
const OPEN_URI_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);

type WarpScheme = "warp" | "warppreview";

type TabConfigDirectory = {
	directory: string;
	scheme: WarpScheme;
	label: string;
};

export type WarpTabConfigOption = {
	disabled?: boolean;
	label: string;
	value: string;
};

/**
 * Normalizes a saved Tab Config name or URI into the value accepted by Warp's URI scheme.
 *
 * The filename stem is used instead of the TOML `name` field because Warp resolves Tab Configs
 * by filename and multiple files may share the same display name.
 */
export function normalizeWarpTabConfig(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const candidate = value.trim();
	if (candidate === "") {
		return undefined;
	}

	if (candidate.includes("://")) {
		return normalizeWarpTabConfigUrl(candidate);
	}

	const stem = normalizeTabConfigStem(candidate);
	return stem === undefined ? undefined : buildWarpTabConfigUrl("warp", stem);
}

/** Returns the filename stem represented by a saved Tab Config name or URI. */
export function getWarpTabConfigStem(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const candidate = value.trim();
	if (candidate === "") {
		return undefined;
	}

	if (candidate.includes("://")) {
		return parseWarpTabConfigUrl(candidate)?.stem;
	}

	return normalizeTabConfigStem(candidate);
}

/** Reads the display name from the selected Tab Config's top-level TOML `name` field. */
export async function getWarpTabConfigDisplayName(value: unknown): Promise<string | undefined> {
	const normalized = normalizeWarpTabConfig(value);
	if (normalized === undefined) {
		return undefined;
	}

	const parsed = parseWarpTabConfigUrl(normalized);
	if (parsed === undefined) {
		return undefined;
	}

	const source = getTabConfigDirectories().find((candidate) => candidate.scheme === parsed.scheme);
	if (source === undefined) {
		return parsed.stem;
	}

	return readDisplayName(path.join(source.directory, `${parsed.stem}${TAB_CONFIG_EXTENSION}`), parsed.stem);
}

/**
 * Lists the local Tab Config files that Warp can open from its stable or preview data directory.
 */
export async function listWarpTabConfigs(): Promise<WarpTabConfigOption[]> {
	const options: WarpTabConfigOption[] = [];
	const seen = new Set<string>();

	for (const source of getTabConfigDirectories()) {
		let entries;
		try {
			entries = await fs.readdir(source.directory, { withFileTypes: true });
		} catch (error) {
			if (isMissingPath(error)) {
				continue;
			}

			throw error;
		}

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith(TAB_CONFIG_EXTENSION)) {
				continue;
			}

			const stem = normalizeTabConfigStem(entry.name.slice(0, -TAB_CONFIG_EXTENSION.length));
			if (stem === undefined) {
				continue;
			}

			const value = buildWarpTabConfigUrl(source.scheme, stem);
			if (seen.has(value)) {
				continue;
			}

			seen.add(value);
			const displayName = await readDisplayName(path.join(source.directory, entry.name), stem);

			options.push({
				label: formatLabel(source, displayName, stem),
				value
			});
		}
	}

	return options.sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
}

/** Opens a validated Tab Config URI through the platform's custom-URI handler. */
export async function openWarpTabConfig(value: unknown): Promise<void> {
	const url = normalizeWarpTabConfig(value);
	if (url === undefined) {
		throw new Error("Warp Tab Config selection is invalid");
	}

	if (process.platform === "win32") {
		await execFileAsync("cmd.exe", ["/d", "/c", "start", "", url], {
			timeout: OPEN_URI_TIMEOUT_MS,
			windowsHide: true
		});
		return;
	}

	if (process.platform === "darwin") {
		await execFileAsync("open", [url], { timeout: OPEN_URI_TIMEOUT_MS });
		return;
	}

	await execFileAsync("xdg-open", [url], { timeout: OPEN_URI_TIMEOUT_MS });
}

function normalizeWarpTabConfigUrl(value: string): string | undefined {
	const parsed = parseWarpTabConfigUrl(value);
	return parsed === undefined ? undefined : buildWarpTabConfigUrl(parsed.scheme, parsed.stem);
}

function parseWarpTabConfigUrl(value: string): { scheme: WarpScheme; stem: string } | undefined {
	if (!/^warp(?:preview)?:\/\/tab_config\/[^/?#]+$/i.test(value)) {
		return undefined;
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}

	const scheme = url.protocol.slice(0, -1).toLowerCase();
	if (scheme !== "warp" && scheme !== "warppreview") {
		return undefined;
	}

	if (url.hostname.toLowerCase() !== "tab_config" || url.username !== "" || url.password !== "" || url.port !== "") {
		return undefined;
	}

	if (url.search !== "" || url.hash !== "") {
		return undefined;
	}

	const encodedStem = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
	let decodedStem: string;
	try {
		decodedStem = decodeURIComponent(encodedStem);
	} catch {
		return undefined;
	}

	const stem = normalizeTabConfigStem(decodedStem);
	return stem === undefined ? undefined : { scheme, stem };
}

function normalizeTabConfigStem(value: string): string | undefined {
	const withoutExtension = value.toLowerCase().endsWith(TAB_CONFIG_EXTENSION)
		? value.slice(0, -TAB_CONFIG_EXTENSION.length)
		: value;

	// Warp lets a saved Tab Config be named freely, so the stem is rejected only for what would make
	// it unsafe as a path segment or as a URI component: traversal, separators, drive separators,
	// wildcards, quoting, and control characters. Everything else is URI-encoded when the URL is built.
	if (withoutExtension === "" || withoutExtension === "." || withoutExtension === "..") {
		return undefined;
	}

	// eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
	if (/[\\/:*?"<>|\u0000-\u001F]/.test(withoutExtension)) {
		return undefined;
	}

	return withoutExtension;
}

function buildWarpTabConfigUrl(scheme: WarpScheme, stem: string): string {
	return `${scheme}://tab_config/${encodeURIComponent(stem)}`;
}

function getTabConfigDirectories(): TabConfigDirectory[] {
	const home = os.homedir();

	if (process.platform === "win32") {
		const appData = process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
		return [
			{
				directory: path.join(appData, "warp", "Warp", "data", "tab_configs"),
				scheme: "warp",
				label: ""
			},
			{
				directory: path.join(appData, "warp", "WarpPreview", "data", "tab_configs"),
				scheme: "warppreview",
				label: "Preview: "
			}
		];
	}

	if (process.platform === "darwin") {
		return [
			{ directory: path.join(home, ".warp", "tab_configs"), scheme: "warp", label: "" },
			{ directory: path.join(home, ".warp-preview", "tab_configs"), scheme: "warppreview", label: "Preview: " }
		];
	}

	const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
	return [
		{ directory: path.join(dataHome, "warp-terminal", "tab_configs"), scheme: "warp", label: "" },
		{ directory: path.join(dataHome, "warp-terminal-preview", "tab_configs"), scheme: "warppreview", label: "Preview: " }
	];
}

async function readDisplayName(filePath: string, fallback: string): Promise<string> {
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf8");
	} catch {
		return fallback;
	}

	// Scanned line by line and stopped at the first table header so a `name` inside a table such as
	// [[panes]] is never mistaken for the config's own top-level name.
	for (const line of content.split(/\r?\n/)) {
		if (/^\s*\[/.test(line)) {
			break;
		}

		const match = /^\s*name\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*$/.exec(line);
		const name = match?.[1] ?? match?.[2];
		if (name === undefined) {
			continue;
		}

		const display = name.replace(/\\(["\\])/g, "$1").trim();
		return display === "" ? fallback : display;
	}

	return fallback;
}

function formatLabel(source: TabConfigDirectory, displayName: string, stem: string): string {
	const suffix = displayName === stem ? stem : `${displayName} (${stem})`;
	return source.label + suffix;
}

function isMissingPath(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
