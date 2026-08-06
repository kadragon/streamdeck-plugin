import assert from "node:assert/strict";
import test from "node:test";

import { isCurrentSystemMetricRevision } from "../src/actions/system-metrics";
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
	const metrics: SystemMetrics = { gpus: [], sampledAt: new Date() };
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
});

test("system monitor ignores an older asynchronous render after settings change", () => {
	assert.equal(isCurrentSystemMetricRevision(2, 1), false);
	assert.equal(isCurrentSystemMetricRevision(2, 2), true);
	assert.equal(isCurrentSystemMetricRevision(undefined, 1), false);
});
