import assert from "node:assert/strict";
import test from "node:test";

import { formatSystemTemperature, renderKey, renderSystemMonitor, systemMetricProgress, systemMonitorAccent, systemStatusLabel } from "../src/render";

function decodeImage(image: string): string {
	return decodeURIComponent(image.slice(image.indexOf(",") + 1));
}

test("renderers keep no-data and unsupported states visibly distinct", () => {
	assert.match(decodeImage(renderKey({ source: "claude" })), />\?</);
	assert.match(decodeImage(renderSystemMonitor({ metric: "cpu", status: "unsupported" })), /UNSUPPORTED/);
	assert.match(decodeImage(renderSystemMonitor({ metric: "cpu" })), /--/);
});

test("gauge progress clamps to the metric's full scale and rejects unusable readings", () => {
	assert.equal(systemMetricProgress("cpu", 42), 42);
	assert.equal(systemMetricProgress("cpu", 0), 0);
	assert.equal(systemMetricProgress("network", 500), 50);
	assert.equal(systemMetricProgress("network", 2_000), 100);
	assert.equal(systemMetricProgress("gpu-power", 125), 25);
	assert.equal(systemMetricProgress("gpu-power", 900), 100);

	// A reading that is absent, non-finite, or outside the metric's plausible range must not resolve to
	// a number, so a missing value can never be drawn as a real low reading.
	assert.equal(systemMetricProgress("cpu", undefined), undefined);
	assert.equal(systemMetricProgress("cpu", Number.NaN), undefined);
	assert.equal(systemMetricProgress("cpu", 140), undefined);
	assert.equal(systemMetricProgress("network", -1), undefined);
});

test("key face draws a gauge fill for a reading and none for a missing one", () => {
	const fills = (image: string): string[] => decodeImage(image).match(/<rect x="22"[^>]*fill="#(?!0B1220)[^"]*"/g) ?? [];

	assert.equal(fills(renderSystemMonitor({ metric: "cpu", value: 50, temperatureC: 40 })).length, 1);
	// A genuine zero stays visibly a reading; a missing one draws the track alone.
	assert.equal(fills(renderSystemMonitor({ metric: "cpu", value: 0, temperatureC: 40 })).length, 1);
	assert.equal(fills(renderSystemMonitor({ metric: "cpu", status: "missing" })).length, 0);
});

test("temperature is shown as a value on the metrics that measure one", () => {
	assert.match(decodeImage(renderSystemMonitor({ metric: "cpu", value: 20, temperatureC: 72 })), /72&#176;/);
	assert.match(decodeImage(renderSystemMonitor({ metric: "gpu", value: 20, temperatureC: 55 })), /55&#176;/);

	// Out of range, unsupported, and metrics with no sensor must not invent a chip.
	assert.doesNotMatch(decodeImage(renderSystemMonitor({ metric: "cpu", value: 20, temperatureC: 900 })), /&#176;/);
	assert.doesNotMatch(decodeImage(renderSystemMonitor({ metric: "cpu", temperatureC: 40, status: "unsupported" })), /&#176;/);
	assert.doesNotMatch(decodeImage(renderSystemMonitor({ metric: "memory", value: 20, temperatureC: 40 })), /&#176;/);
});

test("header names the GPU index only when it is not the default GPU", () => {
	assert.match(decodeImage(renderSystemMonitor({ metric: "gpu", value: 20, gpuIndex: 1 })), />GPU #1</);
	assert.match(decodeImage(renderSystemMonitor({ metric: "gpu", value: 20, gpuIndex: 0 })), />GPU</);
	assert.doesNotMatch(decodeImage(renderSystemMonitor({ metric: "gpu", value: 20, gpuIndex: 0 })), />GPU #/);
	assert.doesNotMatch(decodeImage(renderSystemMonitor({ metric: "cpu", value: 20, gpuIndex: 2 })), />CPU #/);
});

test("dial and key faces share one status, temperature, and accent source", () => {
	assert.equal(systemStatusLabel("ready"), "");
	assert.equal(systemStatusLabel(undefined), "");
	assert.equal(systemStatusLabel("stale"), "STALE");
	assert.equal(systemStatusLabel("missing"), "NO DATA");
	assert.equal(systemStatusLabel("unsupported"), "UNSUPPORTED");

	assert.equal(formatSystemTemperature({ metric: "cpu", temperatureC: 71.4 }), "71°C");
	assert.equal(formatSystemTemperature({ metric: "memory", temperatureC: 71 }), "");
	assert.equal(formatSystemTemperature({ metric: "cpu", temperatureC: 900 }), "");
	assert.equal(formatSystemTemperature({ metric: "cpu", temperatureC: 71, status: "unsupported" }), "");

	// The accent the dial bar uses must be the same colour the key gauge draws.
	const hot = systemMonitorAccent({ metric: "cpu", value: 90, temperatureC: 85 });
	const cool = systemMonitorAccent({ metric: "cpu", value: 90, temperatureC: 40 });
	assert.notEqual(hot, cool);
	assert.match(decodeImage(renderSystemMonitor({ metric: "cpu", value: 90, temperatureC: 85 })), new RegExp(hot));
});
