import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const POWERSHELL = "powershell.exe";
const NVIDIA_SMI = "nvidia-smi.exe";
const MAX_BUFFER = 16 * 1024;

/** Windows performance-counter values that are useful for the System Monitor action. */
export type SystemMetrics = {
	cpuUsagePercent?: number;
	gpuUsagePercent?: number;
	cpuTemperatureC?: number;
	gpuTemperatureC?: number;
};

/** Reject values that cannot represent a real utilization reading. */
const MIN_PERCENT = 0;
const MAX_PERCENT = 100;

/** Broad thermal range for a Windows CPU/GPU sensor, in degrees Celsius. */
const MIN_TEMPERATURE_C = -50;
const MAX_TEMPERATURE_C = 150;

const POWERSHELL_SCRIPT = [
	"$ErrorActionPreference = 'SilentlyContinue'",
	"$cpu = $null",
	"$cpuSample = Get-Counter -Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue",
	"if ($null -ne $cpuSample) { $cpu = $cpuSample.CounterSamples | Select-Object -First 1 -ExpandProperty CookedValue }",
	"$thermal = $null",
	"$thermalSample = Get-Counter -Counter '\\Thermal Zone Information(*)\\High Precision Temperature' -ErrorAction SilentlyContinue",
	"if ($null -ne $thermalSample) { $thermal = $thermalSample.CounterSamples | Select-Object -First 1 -ExpandProperty CookedValue }",
	"[pscustomobject]@{ cpuUsagePercent = $cpu; cpuTemperatureRaw = $thermal } | ConvertTo-Json -Compress"
].join("; ");

const EXEC_OPTIONS = {
	maxBuffer: MAX_BUFFER,
	windowsHide: true
};

/**
 * Reads the local Windows sources used by System Monitor.
 *
 * The action is present in the package shared with the other actions, but its data source is strictly
 * Windows-only. Each individual source failure becomes an unavailable field instead of terminating the
 * plugin or turning a bad reading into zero.
 */
export async function readWindowsMetrics(): Promise<SystemMetrics> {
	if (process.platform !== "win32") {
		throw new Error("Windows system metrics are only available on win32");
	}

	const [cpu, gpu] = await Promise.all([readCpuMetrics(), readNvidiaMetrics()]);
	return { ...cpu, ...gpu };
}

async function readCpuMetrics(): Promise<SystemMetrics> {
	try {
		const { stdout } = await execFileAsync(POWERSHELL, [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			POWERSHELL_SCRIPT
		], EXEC_OPTIONS);
		const payload: unknown = JSON.parse(stdout.trim());

		if (!isRecord(payload)) {
			return {};
		}

		const rawTemperature = asFiniteNumber(payload.cpuTemperatureRaw);
		return {
			cpuUsagePercent: asPercent(payload.cpuUsagePercent),
			cpuTemperatureC: rawTemperature === undefined ? undefined : asTemperature(rawTemperature / 10 - 273.15)
		};
	} catch {
		return {};
	}
}

async function readNvidiaMetrics(): Promise<SystemMetrics> {
	try {
		const { stdout } = await execFileAsync(
			NVIDIA_SMI,
			[
				"--query-gpu=utilization.gpu,temperature.gpu",
				"--format=csv,noheader,nounits"
			],
			EXEC_OPTIONS
		);
		const firstGpu = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== "");

		if (firstGpu === undefined) {
			return {};
		}

		const [usage, temperature] = firstGpu.split(",");
		return {
			gpuUsagePercent: asPercent(usage),
			gpuTemperatureC: asTemperature(temperature)
		};
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : undefined;
	}

	if (typeof value !== "string" || value.trim() === "") {
		return undefined;
	}

	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : undefined;
}

function asPercent(value: unknown): number | undefined {
	const parsed = asFiniteNumber(value);
	return parsed !== undefined && parsed >= MIN_PERCENT && parsed <= MAX_PERCENT ? parsed : undefined;
}

function asTemperature(value: unknown): number | undefined {
	const parsed = asFiniteNumber(value);
	return parsed !== undefined && parsed >= MIN_TEMPERATURE_C && parsed <= MAX_TEMPERATURE_C ? parsed : undefined;
}
