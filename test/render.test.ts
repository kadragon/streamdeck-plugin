import assert from "node:assert/strict";
import test from "node:test";

import { renderKey, renderSystemMonitor } from "../src/render";

function decodeImage(image: string): string {
	return decodeURIComponent(image.slice(image.indexOf(",") + 1));
}

test("renderers keep no-data and unsupported states visibly distinct", () => {
	assert.match(decodeImage(renderKey({ source: "claude" })), />\?</);
	assert.match(decodeImage(renderSystemMonitor({ metric: "cpu", status: "unsupported" })), /UNSUPPORTED/);
	assert.match(decodeImage(renderSystemMonitor({ metric: "cpu" })), /--/);
});
