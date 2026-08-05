import streamDeck from "@elgato/streamdeck";

import { WeeklyLimit } from "./actions/weekly-limit";

streamDeck.logger.setLevel("info");

const weeklyLimit = new WeeklyLimit();
streamDeck.actions.registerAction(weeklyLimit);

// Nothing is read while the machine sleeps, so every key is out of date on wake.
streamDeck.system.onSystemDidWakeUp(() => void weeklyLimit.refreshAll());

streamDeck.connect();
