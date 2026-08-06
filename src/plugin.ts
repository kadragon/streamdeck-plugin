import streamDeck from "@elgato/streamdeck";

import { SystemMonitor } from "./actions/system-metrics";
import { WeeklyLimit } from "./actions/weekly-limit";
import { WarpTabConfig } from "./actions/warp-tab-config";

streamDeck.logger.setLevel("info");

const weeklyLimit = new WeeklyLimit();
const warpTabConfig = new WarpTabConfig();
const systemMonitor = new SystemMonitor();
streamDeck.actions.registerAction(weeklyLimit);
streamDeck.actions.registerAction(warpTabConfig);
streamDeck.actions.registerAction(systemMonitor);

// Nothing is read while the machine sleeps, so every key is out of date on wake.
streamDeck.system.onSystemDidWakeUp(() => {
	weeklyLimit.refreshAll().catch((err) => streamDeck.logger.error("wake refresh failed", err));
	systemMonitor.refreshAll().catch((err) => streamDeck.logger.error("system monitor wake refresh failed", err));
});

streamDeck.connect();
