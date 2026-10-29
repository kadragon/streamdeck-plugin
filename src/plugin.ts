import streamDeck from "@elgato/streamdeck";

import { BreakTimer } from "./actions/break-timer";
import { SystemMonitor } from "./actions/system-metrics";
import { WeeklyLimit } from "./actions/weekly-limit";
import { WarpTabConfig } from "./actions/warp-tab-config";

streamDeck.logger.setLevel("info");

const weeklyLimit = new WeeklyLimit();
const warpTabConfig = new WarpTabConfig();
const systemMonitor = new SystemMonitor();
const breakTimer = new BreakTimer();
streamDeck.actions.registerAction(weeklyLimit);
streamDeck.actions.registerAction(warpTabConfig);
streamDeck.actions.registerAction(systemMonitor);
streamDeck.actions.registerAction(breakTimer);

// Nothing is read while the machine sleeps, so every key is out of date on wake.
streamDeck.system.onSystemDidWakeUp(() => {
	weeklyLimit.refreshAll().catch((err) => streamDeck.logger.error("wake refresh failed", err));
	systemMonitor.refreshAll({ force: true }).catch((err) => streamDeck.logger.error("system monitor wake refresh failed", err));
	breakTimer.refreshAll().catch((err) => streamDeck.logger.error("break timer wake refresh failed", err));
});

streamDeck.connect();
