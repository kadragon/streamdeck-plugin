import assert from "node:assert/strict";
import test from "node:test";

import { normalizeWarpTabConfig } from "../src/warp/tab-configs";
import { normalizeWarpUri } from "../src/warp/uris";

test("Warp URI normalization accepts supported schemes and rejects unsafe URLs", () => {
	assert.equal(normalizeWarpUri("warp://launch"), "warp://launch");
	assert.equal(normalizeWarpUri("warppreview://settings"), "warppreview://settings");
	assert.equal(normalizeWarpUri("https://example.com"), undefined);
	assert.equal(normalizeWarpUri("warp://user@launch"), undefined);
	assert.equal(normalizeWarpUri("warp://la\nunch"), undefined);
});

test("Warp Tab Config normalization always targets a new tab", () => {
	assert.equal(normalizeWarpTabConfig("Project"), "warp://tab_config/Project");
	assert.equal(
		normalizeWarpTabConfig("warppreview://tab_config/Preview%20Config"),
		"warppreview://tab_config/Preview%20Config"
	);
	assert.equal(normalizeWarpTabConfig("Project/name"), undefined);
});
