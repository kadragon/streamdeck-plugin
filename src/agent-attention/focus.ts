import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { normalizeWarpTab } from "./types";

const execFileAsync = promisify(execFile);
const FOCUS_TIMEOUT_MS = 5000;

export type WarpFocusResult =
	| { ok: true }
	| {
			ok: false;
			reason: "invalid-tab" | "unsupported-platform" | "warp-window-not-found" | "focus-command-failed";
	  };

/**
 * Focuses the existing Warp window and selects one of its fixed tab positions.
 *
 * No session discovery is attempted: v1 intentionally delegates tab identity to the configured
 * 1-based position.
 */
export async function focusWarpTab(value: unknown): Promise<WarpFocusResult> {
	const tab = normalizeWarpTab(value);
	if (tab === undefined) {
		return { ok: false, reason: "invalid-tab" };
	}

	if (process.platform === "win32") {
		return focusWindowsWarpTab(tab);
	}

	if (process.platform === "darwin") {
		return focusMacWarpTab(tab);
	}

	return { ok: false, reason: "unsupported-platform" };
}

async function focusWindowsWarpTab(tab: number): Promise<WarpFocusResult> {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type @'",
		"using System;",
		"using System.Runtime.InteropServices;",
		"public static class WarpAttentionNative {",
		"    [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
		"    [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);",
		"}",
		"'@",
		"$warp = Get-Process | Where-Object { $_.ProcessName -in @('Warp', 'warp') -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
		"if ($null -eq $warp) { exit 2 }",
		"[WarpAttentionNative]::ShowWindow($warp.MainWindowHandle, 3) | Out-Null",
		"if (-not [WarpAttentionNative]::SetForegroundWindow($warp.MainWindowHandle)) { exit 3 }",
		"Start-Sleep -Milliseconds 100",
		"Add-Type -AssemblyName System.Windows.Forms",
		"[System.Windows.Forms.SendKeys]::SendWait('^" + tab + "')"
	].join("\n");

	try {
		await execFileAsync(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			{ timeout: FOCUS_TIMEOUT_MS, windowsHide: true }
		);
		return { ok: true };
	} catch (error) {
		if (isExitCode(error, 2)) {
			return { ok: false, reason: "warp-window-not-found" };
		}
		return { ok: false, reason: "focus-command-failed" };
	}
}

async function focusMacWarpTab(tab: number): Promise<WarpFocusResult> {
	const script = [
		'tell application "Warp" to activate',
		"delay 0.15",
		'tell application "System Events"',
		'    keystroke "' + tab + '" using {command down}',
		"end tell"
	].join("\n");

	try {
		await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: FOCUS_TIMEOUT_MS });
		return { ok: true };
	} catch {
		return { ok: false, reason: "focus-command-failed" };
	}
}

function isExitCode(error: unknown, code: number): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}
