import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { accumulateRotationSteps, effectiveRefreshSeconds, isCurrentSystemMetricRevision, normalizeRefreshSeconds } from "../src/actions/system-metrics";
import { SYSTEM_METRIC_KINDS, stepSystemMetric } from "../src/metrics/types";
import { createWindowsMetricsSampler, parseNvidiaMetrics, parsePowerShellMetrics, selectSystemMetric, type SystemMetrics } from "../src/metrics/windows";
import { formatSystemMetric, systemMetricProgress } from "../src/render";

test("Windows metric parsers validate optional fields and calculate GPU memory usage", () => {
	const computer = parsePowerShellMetrics(JSON.stringify({
		cpuUsagePercent: "42.5",
		cpuTemperatureRaw: 3331.5,
		memoryUsagePercent: 68,
		diskUsagePercent: 91,
		networkBytesPerSec: 12_500_000
	}));
	assert.equal(computer.cpuUsagePercent, 42.5);
	assert.equal(Math.round(computer.systemTemperatureC ?? 0), 60);
	assert.equal(computer.networkMbps, 100);

	const gpus = parseNvidiaMetrics("0, 75, 70, 4000, 8000, 120\n1, N/A, N/A, N/A, N/A, N/A");
	assert.equal(gpus.length, 2);
	assert.equal(gpus[0]?.memoryUsagePercent, 50);
	assert.equal(gpus[1]?.usagePercent, undefined);
	assert.equal(selectSystemMetric({ ...computer, gpus }, "memory", 0).value, 68);
	assert.equal(selectSystemMetric({ ...computer, gpus }, "gpu-memory", 0).value, 50);
	assert.equal(selectSystemMetric({ ...computer, gpus }, "gpu-power", 0).value, 120);
});

test("CPU temperature prefers the LibreHardwareMonitor package sensor over the ACPI thermal zone", () => {
	const withPackage = parsePowerShellMetrics(JSON.stringify({
		cpuUsagePercent: 20,
		cpuPackageTemperatureC: 78.5,
		cpuTemperatureRaw: 3331.5
	}));
	assert.equal(withPackage.cpuPackageTemperatureC, 78.5);
	assert.equal(Math.round(withPackage.systemTemperatureC ?? 0), 60);
	assert.equal(selectSystemMetric({ ...withPackage, gpus: [] }, "cpu", 0).temperatureC, 78.5);

	// LibreHardwareMonitor not running: the chassis zone remains the stand-in.
	const withoutPackage = parsePowerShellMetrics(JSON.stringify({ cpuUsagePercent: 20, cpuTemperatureRaw: 3331.5 }));
	assert.equal(withoutPackage.cpuPackageTemperatureC, undefined);
	assert.equal(Math.round(selectSystemMetric({ ...withoutPackage, gpus: [] }, "cpu", 0).temperatureC ?? 0), 60);

	// An unusable package reading must not shadow the fallback.
	for (const bogus of [null, "n/a", Number.NaN, 4_000, -300]) {
		const rejected = parsePowerShellMetrics(JSON.stringify({ cpuPackageTemperatureC: bogus, cpuTemperatureRaw: 3331.5 }));
		assert.equal(rejected.cpuPackageTemperatureC, undefined);
		assert.equal(Math.round(selectSystemMetric({ ...rejected, gpus: [] }, "cpu", 0).temperatureC ?? 0), 60);
	}
});

test("system metric formatting and progress handle network units and unavailable values", () => {
	assert.equal(formatSystemMetric("network", 12.34), "12.3 Mbps");
	assert.equal(formatSystemMetric("network", undefined), "--");
	assert.equal(formatSystemMetric("network", Number.NaN), "--");
	assert.equal(formatSystemMetric("network", 100_001), "--");

	assert.equal(systemMetricProgress("network", 500), 50);
	assert.equal(systemMetricProgress("network", 1_000), 100);
	assert.equal(systemMetricProgress("network", undefined), undefined);
	assert.equal(systemMetricProgress("network", Number.POSITIVE_INFINITY), undefined);
});

test("Windows metrics sampler shares concurrent reads and respects interval cache", async () => {
	let calls = 0;
	const metrics: SystemMetrics = { gpus: [], disks: [], sampledAt: new Date() };
	const sampler = createWindowsMetricsSampler(async () => {
		calls += 1;
		await Promise.resolve();
		return metrics;
	}, 60_000);

	const [first, second] = await Promise.all([sampler.read(), sampler.read()]);
	assert.equal(first, second);
	assert.equal(calls, 1);
	await sampler.read();
	assert.equal(calls, 1);
	await sampler.read(true);
	assert.equal(calls, 2);

	// A configured refresh faster than the constructor interval must not keep serving the cached sample.
	await new Promise((resolve) => setTimeout(resolve, 5));
	await sampler.read(false, 1);
	assert.equal(calls, 3);
	await sampler.read();
	assert.equal(calls, 3);
});

test("the configured refresh interval accepts select strings and clamps out-of-range values", () => {
	assert.equal(normalizeRefreshSeconds(30), 30);
	assert.equal(normalizeRefreshSeconds("60"), 60);
	assert.equal(normalizeRefreshSeconds(" 10 "), 10);
	assert.equal(normalizeRefreshSeconds(1), 5);
	assert.equal(normalizeRefreshSeconds(9_999), 300);

	for (const bogus of [undefined, null, "", "fast", Number.NaN, Number.POSITIVE_INFINITY, {}]) {
		assert.equal(normalizeRefreshSeconds(bogus), 15);
	}
});

test("the shared ticker runs at the fastest configured interval and defaults only when unconfigured", () => {
	// The default answers the empty set; folding it in as a seed would cap every result at 15s.
	assert.equal(effectiveRefreshSeconds([]), 15);
	assert.equal(effectiveRefreshSeconds([{ refreshSeconds: "120" }]), 120);
	assert.equal(effectiveRefreshSeconds([{ refreshSeconds: "5" }]), 5);
	assert.equal(effectiveRefreshSeconds([{ refreshSeconds: 300 }]), 300);

	// The fastest visible key wins, whichever order the map yields.
	assert.equal(effectiveRefreshSeconds([{ refreshSeconds: "60" }, { refreshSeconds: "5" }]), 5);
	assert.equal(effectiveRefreshSeconds([{ refreshSeconds: "5" }, { refreshSeconds: "60" }]), 5);

	// A key that never chose an interval, or stored an unusable one, contributes the default.
	assert.equal(effectiveRefreshSeconds([{ metric: "cpu" }]), 15);
	assert.equal(effectiveRefreshSeconds([{ refreshSeconds: "fast" }]), 15);
	assert.equal(effectiveRefreshSeconds([{ refreshSeconds: 9_999 }, { metric: "cpu" }]), 15);
	assert.equal(effectiveRefreshSeconds([{ refreshSeconds: "120" }, { metric: "cpu" }]), 15);
});

test("per-drive disk rows are validated and a single drive survives the JSON array collapse", () => {
	const many = parsePowerShellMetrics(JSON.stringify({
		diskUsagePercent: 60,
		disks: [
			{ id: "C:", usagePercent: 91 },
			{ id: "D:", usagePercent: "42.5" },
			{ id: "E:", usagePercent: 140 },
			{ id: "", usagePercent: 10 },
			{ id: 3, usagePercent: 10 },
			"not-a-row"
		]
	}));
	assert.deepEqual(many.disks, [
		{ id: "C:", usagePercent: 91 },
		{ id: "D:", usagePercent: 42.5 },
		// An out-of-range percentage is dropped while the drive itself stays selectable.
		{ id: "E:", usagePercent: undefined }
	]);

	// ConvertTo-Json -Compress emits a bare object when exactly one fixed drive exists.
	const one = parsePowerShellMetrics(JSON.stringify({ disks: { id: "C:", usagePercent: 12 } }));
	assert.deepEqual(one.disks, [{ id: "C:", usagePercent: 12 }]);
	assert.deepEqual(parsePowerShellMetrics("not json").disks, []);
	assert.deepEqual(parsePowerShellMetrics(JSON.stringify({ disks: 7 })).disks, []);
});

test("the disk metric can be scoped to one drive and reports nothing when it is gone", () => {
	const metrics: SystemMetrics = {
		gpus: [],
		diskUsagePercent: 60,
		disks: [{ id: "C:", usagePercent: 91 }, { id: "D:" }]
	};

	// No scope keeps the aggregate over every fixed drive.
	assert.equal(selectSystemMetric(metrics, "disk", 0).value, 60);
	assert.equal(selectSystemMetric(metrics, "disk", 0, "   ").value, 60);

	// Stream Deck settings may carry a trailing separator or different casing than Win32_LogicalDisk.
	assert.equal(selectSystemMetric(metrics, "disk", 0, "C:").value, 91);
	assert.equal(selectSystemMetric(metrics, "disk", 0, "c:\\").value, 91);

	// A drive that is present but unreadable, and one that is gone, both leave the value unavailable.
	assert.equal(selectSystemMetric(metrics, "disk", 0, "D:").value, undefined);
	assert.equal(selectSystemMetric(metrics, "disk", 0, "Z:").value, undefined);
});

test("system monitor ignores an older asynchronous render after settings change", () => {
	assert.equal(isCurrentSystemMetricRevision(2, 1), false);
	assert.equal(isCurrentSystemMetricRevision(2, 2), true);
	assert.equal(isCurrentSystemMetricRevision(undefined, 1), false);
});

test("the Property Inspector offers exactly the rotation order", async () => {
	// The dial steps through SYSTEM_METRIC_KINDS while the inspector renders its own <option> list.
	// Nothing but this test stops an edit to one from silently disagreeing with the other.
	const inspector = await fs.readFile(
		path.join(import.meta.dirname, "..", "com.kadragon.aiusage.sdPlugin", "ui", "system-monitor.html"),
		"utf8"
	);
	const select = /<sdpi-select setting="metric"[\s\S]*?<\/sdpi-select>/.exec(inspector)?.[0];
	assert.ok(select, "the metric selector is missing from the Property Inspector");

	const options = [...select.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
	assert.deepEqual(options, [...SYSTEM_METRIC_KINDS]);
});

test("metric rotation wraps in both directions and recovers from an unknown metric", () => {
	// A full turn in either direction must land back where it started.
	for (const metric of SYSTEM_METRIC_KINDS) {
		assert.equal(stepSystemMetric(metric, SYSTEM_METRIC_KINDS.length), metric);
		assert.equal(stepSystemMetric(stepSystemMetric(metric, 1), -1), metric);
	}

	assert.equal(stepSystemMetric("cpu", 1), SYSTEM_METRIC_KINDS[1]);
	assert.equal(stepSystemMetric(SYSTEM_METRIC_KINDS[0], -1), SYSTEM_METRIC_KINDS[SYSTEM_METRIC_KINDS.length - 1]);
	assert.equal(stepSystemMetric("not-a-metric", 0), SYSTEM_METRIC_KINDS[0]);
	assert.equal(stepSystemMetric(undefined, 1), SYSTEM_METRIC_KINDS[1]);
});

test("dial rotation steps on accumulated ticks and restarts the count on reversal", () => {
	// One detent is half a step, so a single tick only carries; the second tick commits the change.
	assert.deepEqual(accumulateRotationSteps(0, 1), { steps: 0, remainder: 1 });
	assert.deepEqual(accumulateRotationSteps(1, 1), { steps: 1, remainder: 0 });
	assert.deepEqual(accumulateRotationSteps(0, 5), { steps: 2, remainder: 1 });
	assert.deepEqual(accumulateRotationSteps(0, -2), { steps: -1, remainder: 0 });

	// Turning back discards the carried tick instead of spending the reversal on cancelling it.
	assert.deepEqual(accumulateRotationSteps(1, -1), { steps: 0, remainder: -1 });
	assert.deepEqual(accumulateRotationSteps(3, 0), { steps: 0, remainder: 3 });
	assert.deepEqual(accumulateRotationSteps(3, Number.NaN), { steps: 0, remainder: 3 });
});
