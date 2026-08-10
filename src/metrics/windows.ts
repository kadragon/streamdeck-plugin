import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { SystemMetricKind } from "./types";

const execFileAsync = promisify(execFile);

const POWERSHELL = "powershell.exe";
const NVIDIA_SMI = "nvidia-smi.exe";
const MAX_BUFFER = 32 * 1024;
// One sample costs seconds (PowerShell start, CIM queries, the temperature fallback chain, nvidia-smi),
// so the interval stays well above the sample cost to keep the monitor from loading the machine.
const DEFAULT_SAMPLE_INTERVAL_MS = 15_000;

export type NvidiaGpuMetrics = {
	index: number;
	usagePercent?: number;
	temperatureC?: number;
	memoryUsedMiB?: number;
	memoryTotalMiB?: number;
	memoryUsagePercent?: number;
	powerW?: number;
};

/** One fixed drive as reported by Win32_LogicalDisk, so a key can be scoped to a single volume. */
export type SystemDiskMetrics = {
	id: string;
	usagePercent?: number;
};

export type SystemMetrics = {
	sampledAt?: Date;
	cpuUsagePercent?: number;
	/** ACPI thermal zone, not the CPU package sensor — it reflects chassis/system heat. */
	systemTemperatureC?: number;
	/**
	 * True CPU package temperature in °C, available only while LibreHardwareMonitor or
	 * OpenHardwareMonitor is running with its WMI provider enabled.
	 */
	cpuPackageTemperatureC?: number;
	memoryUsagePercent?: number;
	/** Aggregate usage across every fixed drive; the default reading for the `disk` metric. */
	diskUsagePercent?: number;
	networkMbps?: number;
	gpus: NvidiaGpuMetrics[];
	disks: SystemDiskMetrics[];
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

// Counter *names* are localized, so CPU and network read the locale-independent CIM perf classes
// instead of Get-Counter paths; those classes are also pre-formatted, avoiding a 1s sample per read.
const POWERSHELL_SCRIPT = [
	"$ErrorActionPreference = 'SilentlyContinue'",
	"$cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty PercentProcessorTime",
	// LibreHardwareMonitor (and its OpenHardwareMonitor predecessor) publish the real CPU package
	// sensor in °C over WMI, but only while running. The ACPI thermal zone below stays as the
	// fallback for machines without either, where a chassis reading beats no reading at all.
	"$package = $null",
	"foreach ($ns in @('root/LibreHardwareMonitor','root/OpenHardwareMonitor')) { if ($null -ne $package) { continue }; $sensors = @(Get-CimInstance -Namespace $ns -ClassName Sensor -Filter \"SensorType='Temperature'\" -ErrorAction SilentlyContinue); if ($sensors.Count -eq 0) { continue }; $named = $sensors | Where-Object { $_.Name -match 'CPU Package|Tctl|Tdie' } | Select-Object -First 1; if ($null -ne $named) { $package = $named.Value } else { $cores = @($sensors | Where-Object { $_.Name -match '^CPU Core #\\d+$' }); if ($cores.Count -gt 0) { $package = ($cores | Measure-Object -Property Value -Average).Average } } }",
	"$thermal = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty CurrentTemperature",
	"if ($null -eq $thermal) { $thermalSample = Get-Counter -Counter '\\Thermal Zone Information(*)\\High Precision Temperature' -ErrorAction SilentlyContinue; if ($null -ne $thermalSample) { $thermal = $thermalSample.CounterSamples | Select-Object -First 1 -ExpandProperty CookedValue } }",
	"$memory = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue | Select-Object -First 1",
	"$memoryPercent = $null",
	"if ($null -ne $memory -and [double]$memory.TotalVisibleMemorySize -gt 0) { $memoryPercent = 100 - (([double]$memory.FreePhysicalMemory / [double]$memory.TotalVisibleMemorySize) * 100) }",
	"$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction SilentlyContinue)",
	"$diskSize = ($disks | Measure-Object -Property Size -Sum).Sum",
	"$diskFree = ($disks | Measure-Object -Property FreeSpace -Sum).Sum",
	"$diskPercent = $null",
	"if ([double]$diskSize -gt 0) { $diskPercent = 100 - (([double]$diskFree / [double]$diskSize) * 100) }",
	// Per-drive rows let a key be scoped to one volume while the aggregate above stays the default.
	"$diskRows = @($disks | ForEach-Object { $size = [double]$_.Size; $free = [double]$_.FreeSpace; $rowPercent = $null; if ($size -gt 0) { $rowPercent = 100 - (($free / $size) * 100) }; [pscustomobject]@{ id = $_.DeviceID; usagePercent = $rowPercent } })",
	// Loopback, tunnel, and virtual-switch adapters double-count the same traffic as their physical peer.
	"$adapters = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch 'Loopback|isatap|Teredo|Pseudo-Interface|vEthernet|Virtual' })",
	"$networkBytes = ($adapters | Measure-Object -Property BytesTotalPersec -Sum).Sum",
	"[pscustomobject]@{ cpuUsagePercent = $cpu; cpuPackageTemperatureC = $package; cpuTemperatureRaw = $thermal; memoryUsagePercent = $memoryPercent; diskUsagePercent = $diskPercent; disks = $diskRows; networkBytesPerSec = $networkBytes } | ConvertTo-Json -Compress -Depth 3"
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

	/**
	 * @param maxAgeMs How old a settled sample may be before it is re-read; defaults to the
	 * constructor interval. A configurable refresh rate has to pass its own value, otherwise a fast
	 * ticker would keep re-rendering a sample the cache still considers fresh.
	 */
	read(force = false, maxAgeMs?: number): Promise<SystemMetrics> {
		const maxAge = typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : this.#intervalMs;
		const now = Date.now();
		const current = this.#sample;
		if (current !== undefined && (!current.settled || (!force && now - current.startedAt < maxAge))) {
			return current.promise;
		}

		const sample: { startedAt: number; settled: boolean; promise: Promise<SystemMetrics> } = {
			startedAt: now,
			settled: false,
			promise: Promise.resolve({ gpus: [], disks: [] })
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
		return { disks: [] };
	}

	if (!isRecord(payload)) {
		return { disks: [] };
	}

	const rawTemperature = asFiniteNumber(payload.cpuTemperatureRaw);
	return {
		cpuUsagePercent: asPercent(payload.cpuUsagePercent),
		systemTemperatureC: rawTemperature === undefined ? undefined : asTemperature(rawTemperature / 10 - 273.15),
		cpuPackageTemperatureC: asTemperature(payload.cpuPackageTemperatureC),
		memoryUsagePercent: asPercent(payload.memoryUsagePercent),
		diskUsagePercent: asPercent(payload.diskUsagePercent),
		disks: parseDiskRows(payload.disks),
		networkMbps: asRate(payload.networkBytesPerSec)
	};
}

/** Reads the per-drive rows; `ConvertTo-Json -Compress` collapses a single-drive array to one object. */
function parseDiskRows(value: unknown): SystemDiskMetrics[] {
	const rows = Array.isArray(value) ? value : isRecord(value) ? [value] : [];
	return rows.flatMap((row) => {
		if (!isRecord(row)) {
			return [];
		}

		const id = typeof row.id === "string" ? row.id.trim() : "";
		return id === "" ? [] : [{ id, usagePercent: asPercent(row.usagePercent) }];
	});
}

/** Compares drive identifiers ignoring case and the trailing separator Windows tools add. */
export function normalizeDiskDrive(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim().replace(/[\\/]+$/, "").toUpperCase();
	return trimmed === "" ? undefined : trimmed;
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

export function selectSystemMetric(metrics: SystemMetrics, metric: SystemMetricKind, gpuIndex: number, diskDrive?: string): SystemMetricReading {
		if (metric === "cpu") {
			// Package sensor first; the ACPI chassis zone is only a stand-in when LHM/OHM is not running.
			return { value: metrics.cpuUsagePercent, unit: "percent", temperatureC: metrics.cpuPackageTemperatureC ?? metrics.systemTemperatureC };
		}
		if (metric === "gpu") {
			const gpu = metrics.gpus.find((candidate) => candidate.index === gpuIndex);
			return { value: gpu?.usagePercent, unit: "percent", temperatureC: gpu?.temperatureC };
		}
		if (metric === "memory") {
			return { value: metrics.memoryUsagePercent, unit: "percent" };
		}
		if (metric === "disk") {
			const scope = normalizeDiskDrive(diskDrive);
			if (scope === undefined) {
				return { value: metrics.diskUsagePercent, unit: "percent" };
			}

			// A drive that is no longer present leaves the value unavailable rather than silently
			// falling back to the aggregate, which would misreport a scoped key as healthy.
			const drive = metrics.disks.find((candidate) => normalizeDiskDrive(candidate.id) === scope);
			return { value: drive?.usagePercent, unit: "percent" };
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
		return { disks: [] };
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
