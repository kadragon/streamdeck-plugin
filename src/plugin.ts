import streamDeck from "@elgato/streamdeck";

import { WeeklyLimit } from "./actions/weekly-limit";
import { WarpTabConfig } from "./actions/warp-tab-config";

streamDeck.logger.setLevel("info");

const weeklyLimit = new WeeklyLimit();
const warpTabConfig = new WarpTabConfig();
streamDeck.actions.registerAction(weeklyLimit);
streamDeck.actions.registerAction(warpTabConfig);

// Nothing is read while the machine sleeps, so every key is out of date on wake.
streamDeck.system.onSystemDidWakeUp(() => {
	weeklyLimit.refreshAll().catch((err) => streamDeck.logger.error("wake refresh failed", err));
});

streamDeck.connect();
