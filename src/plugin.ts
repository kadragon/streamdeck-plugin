import streamDeck from "@elgato/streamdeck";

import { AgentAttention } from "./actions/agent-attention";
import { WeeklyLimit } from "./actions/weekly-limit";
import { WarpTabConfig } from "./actions/warp-tab-config";

streamDeck.logger.setLevel("info");

const weeklyLimit = new WeeklyLimit();
const agentAttention = new AgentAttention();
const warpTabConfig = new WarpTabConfig();
streamDeck.actions.registerAction(weeklyLimit);
streamDeck.actions.registerAction(agentAttention);
streamDeck.actions.registerAction(warpTabConfig);

// Nothing is read while the machine sleeps, so every key is out of date on wake.
streamDeck.system.onSystemDidWakeUp(() => {
	weeklyLimit.refreshAll().catch((err) => streamDeck.logger.error("wake refresh failed", err));
});

streamDeck.connect();
