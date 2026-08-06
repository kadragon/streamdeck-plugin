import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const OPEN_URI_TIMEOUT_MS = 5_000;

export type WarpUriScheme = "warp" | "warppreview";

/** Accepts only Warp's registered URI schemes, including launch and settings deep links. */
export function normalizeWarpUri(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const candidate = value.trim();
	if (candidate === "" || /[\u0000-\u001F\u007F]/.test(candidate) || !/^warp(?:preview)?:\/\//i.test(candidate)) {
		return undefined;
	}

	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return undefined;
	}

	const scheme = parsed.protocol.slice(0, -1).toLowerCase();
	if ((scheme !== "warp" && scheme !== "warppreview") || parsed.hostname === "" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "") {
		return undefined;
	}

	return candidate;
}

/** Opens a previously validated Warp URI using the platform's native URI handler. */
export async function openWarpUri(value: unknown): Promise<void> {
	const url = normalizeWarpUri(value);
	if (url === undefined) {
		throw new Error("Warp URI is invalid");
	}

	if (process.platform === "win32") {
		await execFileAsync("explorer.exe", [url], { timeout: OPEN_URI_TIMEOUT_MS, windowsHide: true });
		return;
	}

	if (process.platform === "darwin") {
		await execFileAsync("open", [url], { timeout: OPEN_URI_TIMEOUT_MS });
		return;
	}

	await execFileAsync("xdg-open", [url], { timeout: OPEN_URI_TIMEOUT_MS });
}
