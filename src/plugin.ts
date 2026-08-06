import streamDeck from "@elgato/streamdeck";

import { SystemMonitor } from "./actions/system-metrics";
import { UsageOverview } from "./actions/usage-overview";
import { WeeklyLimit } from "./actions/weekly-limit";
import { WarpTabConfig } from "./actions/warp-tab-config";
import { WarpUriLauncher } from "./actions/warp-uri";

streamDeck.logger.setLevel("info");

const weeklyLimit = new WeeklyLimit();
const usageOverview = new UsageOverview();
const warpTabConfig = new WarpTabConfig();
const warpUriLauncher = new WarpUriLauncher();
const systemMonitor = new SystemMonitor();
streamDeck.actions.registerAction(weeklyLimit);
streamDeck.actions.registerAction(usageOverview);
streamDeck.actions.registerAction(warpTabConfig);
streamDeck.actions.registerAction(warpUriLauncher);
streamDeck.actions.registerAction(systemMonitor);

// Nothing is read while the machine sleeps, so every key is out of date on wake.
streamDeck.system.onSystemDidWakeUp(() => {
	weeklyLimit.refreshAll().catch((err) => streamDeck.logger.error("wake refresh failed", err));
	usageOverview.refreshAll().catch((err) => streamDeck.logger.error("usage overview wake refresh failed", err));
	systemMonitor.refreshAll({ force: true }).catch((err) => streamDeck.logger.error("system monitor wake refresh failed", err));
});

streamDeck.connect();
