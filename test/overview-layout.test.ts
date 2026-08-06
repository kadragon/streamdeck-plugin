import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildOverviewFeedback, USAGE_OVERVIEW_LAYOUT } from "../src/actions/usage-overview";
import { overviewDetailLabel, overviewStateColor, type UsageOverviewProviderFace } from "../src/render";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const layoutPath = path.join(repoRoot, "com.kadragon.aiusage.sdPlugin", USAGE_OVERVIEW_LAYOUT);

type LayoutItem = { key: string; type: string };

function readLayout(): { id: string; items: LayoutItem[] } {
	return JSON.parse(fs.readFileSync(layoutPath, "utf8")) as { id: string; items: LayoutItem[] };
}

test("every feedback slot the dial writes exists in the custom layout", () => {
	const layout = readLayout();
	const declared = new Set(layout.items.map((item) => item.key));

	const feedback = buildOverviewFeedback({
		mode: "used",
		claude: { source: "claude", text: "42%", state: "ready", progress: 42 },
		codex: { source: "codex", text: "--", state: "missing", detail: "missing" }
	});

	for (const key of Object.keys(feedback)) {
		assert.ok(declared.has(key), `layout is missing slot "${key}"`);
	}
	// The layout must not be a subset either: an unwritten slot would show its placeholder forever.
	for (const key of declared) {
		assert.ok(key in feedback, `dial never writes layout slot "${key}"`);
	}
});

test("bars are disabled rather than zeroed when a mode carries no percentage", () => {
	// Reset is the mode getOverviewMetric never attaches a percentage to; a provider with no burn
	// rate is the other progress-less shape it emits.
	const feedback = buildOverviewFeedback({
		mode: "reset",
		claude: { source: "claude", text: "3h 12m", state: "ready" },
		codex: { source: "codex", text: "--", state: "ready", detail: "no-reset" }
	});

	assert.deepEqual(feedback["claude-bar"], { enabled: false, value: 0 });
	assert.deepEqual(feedback["codex-bar"], { enabled: false, value: 0 });

	// Burn does carry a percentage whenever a rate exists, so its bar stays enabled.
	const burn = buildOverviewFeedback({
		mode: "burn",
		claude: { source: "claude", text: "3.1%/h", state: "ready", progress: 3.1 },
		codex: { source: "codex", text: "--", state: "missing", detail: "no-burn" }
	});
	assert.equal((burn["claude-bar"] as { enabled: boolean }).enabled, true);
	assert.deepEqual(burn["codex-bar"], { enabled: false, value: 0 });

	const used = buildOverviewFeedback({
		mode: "used",
		claude: { source: "claude", text: "42%", state: "ready", progress: 42 },
		codex: { source: "codex", text: "70%", state: "warning", progress: 70 }
	});
	assert.equal((used["claude-bar"] as { enabled: boolean }).enabled, true);
	assert.equal((used["claude-bar"] as { value: number }).value, 42);
	assert.equal((used["codex-bar"] as { bar_fill_c: string }).bar_fill_c, overviewStateColor({ source: "codex", text: "70%", state: "warning", progress: 70 }));
});

test("shared state and detail mappings cover every provider state", () => {
	const base = { source: "claude", text: "1%" } as const;
	const colors = (["ready", "stale", "warning", "missing"] as const).map((state) => overviewStateColor({ ...base, state }));
	assert.equal(new Set(colors).size, 4, "each state must be visually distinct");

	assert.equal(overviewDetailLabel({ ...base, state: "ready" }), "");
	assert.equal(overviewDetailLabel({ ...base, state: "stale" }), "STALE");
	assert.equal(overviewDetailLabel({ ...base, state: "missing", detail: "missing" }), "NO DATA");
	assert.equal(overviewDetailLabel({ ...base, state: "ready", detail: "no-burn" }), "NO RATE");
	assert.equal(overviewDetailLabel({ ...base, state: "ready", detail: "no-reset" }), "NO RESET");

	// Stale wins over a detail so the row never claims a rate it can no longer vouch for.
	const staleWithDetail: UsageOverviewProviderFace = { ...base, state: "stale", detail: "no-burn" };
	assert.equal(overviewDetailLabel(staleWithDetail), "STALE");
});

test("the manifest points the overview encoder at the custom layout", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "com.kadragon.aiusage.sdPlugin", "manifest.json"), "utf8")) as {
		Actions: { UUID: string; Encoder?: { layout?: string } }[];
	};
	const overview = manifest.Actions.find((entry) => entry.UUID === "com.kadragon.aiusage.overview");
	assert.equal(overview?.Encoder?.layout, USAGE_OVERVIEW_LAYOUT);
});
