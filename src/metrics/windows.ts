import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SystemMetricKind } from "./types";

const execFileAsync = promisify(execFile);

const POWERSHELL = "powershell.exe";
const NVIDIA_SMI = "nvidia-smi.exe";
const MAX_BUFFER = 32 * 1024;
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;

export type NvidiaGpuMetrics = {
	index: number;
	usagePercent?: number;
	temperatureC?: number;
	memoryUsedMiB?: number;
	memoryTotalMiB?: number;
	memoryUsagePercent?: number;
	powerW?: number;
};

export type SystemMetrics = {
	sampledAt?: Date;
	cpuUsagePercent?: number;
	cpuTemperatureC?: number;
	memoryUsagePercent?: number;
	diskUsagePercent?: number;
	networkMbps?: number;
	gpus: NvidiaGpuMetrics[];
};

export type SystemMetricReading = {
	value?: number;
	unit: "percent" | "mbps" | "watts";
	temperatureC?: number;
};

export class UnsupportedSystemMetricsError extends Error {
	constructor() {
		super("Windows system metrics are only available on win32");
		this.name = "UnsupportedSystemMetricsError";
	}
}

const EXEC_OPTIONS = {
	maxBuffer: MAX_BUFFER,
	windowsHide: true
};

const POWERSHELL_SCRIPT = [
	"$ErrorActionPreference = 'SilentlyContinue'",
	"$cpu = $null",
	"$cpuSample = Get-Counter -Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue",
	"if ($null -ne $cpuSample) { $cpu = $cpuSample.CounterSamples | Select-Object -First 1 -ExpandProperty CookedValue }",
	"$thermal = $null",
	"$thermalSample = Get-Counter -Counter '\\Thermal Zone Information(*)\\High Precision Temperature' -ErrorAction SilentlyContinue",
	"if ($null -ne $thermalSample) { $thermal = $thermalSample.CounterSamples | Select-Object -First 1 -ExpandProperty CookedValue }",
	"$memory = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue | Select-Object -First 1",
	"$memoryPercent = $null",
	"if ($null -ne $memory -and [double]$memory.TotalVisibleMemorySize -gt 0) { $memoryPercent = 100 - (([double]$memory.FreePhysicalMemory / [double]$memory.TotalVisibleMemorySize) * 100) }",
	"$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue)",
	"$diskSize = ($disks | Measure-Object -Property Size -Sum).Sum",
	"$diskFree = ($disks | Measure-Object -Property FreeSpace -Sum).Sum",
	"$diskPercent = $null",
	"if ([double]$diskSize -gt 0) { $diskPercent = 100 - (([double]$diskFree / [double]$diskSize) * 100) }",
	"$networkSample = Get-Counter -Counter '\\Network Interface(*)\\Bytes Total/sec' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue",
	"$networkBytes = $null",
	"if ($null -ne $networkSample) { $networkBytes = ($networkSample.CounterSamples | Measure-Object -Property CookedValue -Sum).Sum }",
	"[pscustomobject]@{ cpuUsagePercent = $cpu; cpuTemperatureRaw = $thermal; memoryUsagePercent = $memoryPercent; diskUsagePercent = $diskPercent; networkBytesPerSec = $networkBytes } | ConvertTo-Json -Compress"
].join("; ");

/** Reads the local Windows sources used by System Monitor. */
export async function readWindowsMetrics(): Promise<SystemMetrics> {
	if (process.platform !== "win32") {
		throw new UnsupportedSystemMetricsError();
	}

	const [base, gpus] = await Promise.all([readComputerMetrics(), readNvidiaMetrics()]);
	return { ...base, gpus, sampledAt: new Date() };
}

/** Creates the shared sample cache used by all visible System Monitor instances. */
export function createWindowsMetricsSampler(
	reader: () => Promise<SystemMetrics> = readWindowsMetrics,
	intervalMs = DEFAULT_SAMPLE_INTERVAL_MS
): WindowsMetricsSampler {
	return new WindowsMetricsSampler(reader, intervalMs);
}

export class WindowsMetricsSampler {
	#sample?: { startedAt: number; settled: boolean; promise: Promise<SystemMetrics> };
	readonly #reader: () => Promise<SystemMetrics>;
	readonly #intervalMs: number;

	constructor(reader: () => Promise<SystemMetrics>, intervalMs = DEFAULT_SAMPLE_INTERVAL_MS) {
		this.#reader = reader;
		this.#intervalMs = intervalMs;
	}

	read(force = false): Promise<SystemMetrics> {
		const now = Date.now();
		const current = this.#sample;
		if (current !== undefined && (!current.settled || (!force && now - current.startedAt < this.#intervalMs))) {
			return current.promise;
		}

		const sample: { startedAt: number; settled: boolean; promise: Promise<SystemMetrics> } = {
			startedAt: now,
			settled: false,
			promise: Promise.resolve({ gpus: [] })
		};
		sample.promise = this.#reader().finally(() => {
			sample.settled = true;
		});
		this.#sample = sample;
		return sample.promise;
	}
}

/** Parses the compact PowerShell JSON payload; malformed fields remain unavailable. */
export function parsePowerShellMetrics(stdout: string): Omit<SystemMetrics, "gpus" | "sampledAt"> {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout.trim());
	} catch {
		return {};
	}

	if (!isRecord(payload)) {
		return {};
	}

	const rawTemperature = asFiniteNumber(payload.cpuTemperatureRaw);
	return {
		cpuUsagePercent: asPercent(payload.cpuUsagePercent),
		cpuTemperatureC: rawTemperature === undefined ? undefined : asTemperature(rawTemperature / 10 - 273.15),
		memoryUsagePercent: asPercent(payload.memoryUsagePercent),
		diskUsagePercent: asPercent(payload.diskUsagePercent),
		networkMbps: asRate(payload.networkBytesPerSec)
	};
}

/** Parses all NVIDIA rows so different visible keys can select different GPU indices. */
export function parseNvidiaMetrics(stdout: string): NvidiaGpuMetrics[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.flatMap((line) => {
			const [index, usage, temperature, memoryUsed, memoryTotal, power] = line.split(",").map((part) => part.trim());
			const parsedIndex = asGpuIndex(index);
			if (parsedIndex === undefined) {
				return [];
			}

			const used = asNonNegativeNumber(memoryUsed);
			const total = asNonNegativeNumber(memoryTotal);
			const memoryUsagePercent = used !== undefined && total !== undefined && total > 0 ? asPercent((used / total) * 100) : undefined;
			return [{
				index: parsedIndex,
				usagePercent: asPercent(usage),
				temperatureC: asTemperature(temperature),
				memoryUsedMiB: used,
				memoryTotalMiB: total,
				memoryUsagePercent,
				powerW: asRange(power, 0, 2_000)
			}];
		});
}

export function selectSystemMetric(metrics: SystemMetrics, metric: SystemMetricKind, gpuIndex: number): SystemMetricReading {
		if (metric === "cpu") {
			return { value: metrics.cpuUsagePercent, unit: "percent", temperatureC: metrics.cpuTemperatureC };
		}
		if (metric === "gpu") {
			const gpu = metrics.gpus.find((candidate) => candidate.index === gpuIndex);
			return { value: gpu?.usagePercent, unit: "percent", temperatureC: gpu?.temperatureC };
		}
		if (metric === "memory") {
			return { value: metrics.memoryUsagePercent, unit: "percent" };
		}
		if (metric === "disk") {
			return { value: metrics.diskUsagePercent, unit: "percent" };
		}
		if (metric === "network") {
			return { value: metrics.networkMbps, unit: "mbps" };
		}

		const gpu = metrics.gpus.find((candidate) => candidate.index === gpuIndex);
		return {
			value: metric === "gpu-memory" ? gpu?.memoryUsagePercent : gpu?.powerW,
			unit: metric === "gpu-memory" ? "percent" : "watts"
		};
}

async function readComputerMetrics(): Promise<Omit<SystemMetrics, "gpus" | "sampledAt">> {
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
		return parsePowerShellMetrics(stdout);
	} catch {
		return {};
	}
}

async function readNvidiaMetrics(): Promise<NvidiaGpuMetrics[]> {
	try {
		const { stdout } = await execFileAsync(
			NVIDIA_SMI,
			[
				"--query-gpu=index,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw",
				"--format=csv,noheader,nounits"
			],
			EXEC_OPTIONS
		);
		return parseNvidiaMetrics(stdout);
	} catch {
		return [];
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

function asNonNegativeNumber(value: unknown): number | undefined {
	const parsed = asFiniteNumber(value);
	return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function asPercent(value: unknown): number | undefined {
	return asRange(value, 0, 100);
}

function asTemperature(value: unknown): number | undefined {
	return asRange(value, -50, 150);
}

function asRate(value: unknown): number | undefined {
	const parsed = asNonNegativeNumber(value);
	return parsed === undefined ? undefined : asRange((parsed * 8) / 1_000_000, 0, 100_000);
}

function asRange(value: unknown, minimum: number, maximum: number): number | undefined {
	const parsed = asFiniteNumber(value);
	return parsed !== undefined && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

function asGpuIndex(value: unknown): number | undefined {
	const parsed = asFiniteNumber(value);
	return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0 && parsed <= 64 ? parsed : undefined;
}
