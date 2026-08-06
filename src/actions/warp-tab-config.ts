import {
	action,
	KeyAction,
	SingletonAction,
	streamDeck,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type SendToPluginEvent,
	type WillAppearEvent
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { renderWarpTabKey } from "../render";
import { getWarpTabConfigDisplayName, listWarpTabConfigs, normalizeWarpTabConfig, openWarpTabConfig, type WarpTabConfigOption } from "../warp/tab-configs";

export type WarpTabConfigSettings = {
	tabConfig?: string;
};

type DataSourceRequest = {
	event?: string;
	isRefresh?: boolean;
};

const TAB_CONFIG_DATA_SOURCE = "warpTabConfigs";
const EMPTY_OPTIONS: WarpTabConfigOption[] = [
	{ disabled: true, label: "No Warp Tab Configs found", value: "" }
];

/** Opens a selected local Warp Tab Config through Warp's URI scheme. */
@action({ UUID: "com.kadragon.aiusage.warp-tab-config" })
export class WarpTabConfig extends SingletonAction<WarpTabConfigSettings> {
	override async onWillAppear(ev: WillAppearEvent<WarpTabConfigSettings>): Promise<void> {
		if (ev.action.isKey()) {
			await this.#refresh(ev.action, ev.payload.settings);
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<WarpTabConfigSettings>): Promise<void> {
		if (ev.action.isKey()) {
			await this.#refresh(ev.action, ev.payload.settings);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<WarpTabConfigSettings>): Promise<void> {
		const url = normalizeWarpTabConfig(ev.payload.settings.tabConfig);
		if (url === undefined) {
			streamDeck.logger.error("Warp Tab Config key has no valid selection");
			await ev.action.showAlert();
			return;
		}

		try {
			await openWarpTabConfig(url);
		} catch (error) {
			streamDeck.logger.error(`failed to open Warp Tab Config: ${url}`, error);
			await ev.action.showAlert();
		}
	}

	async #refresh(target: KeyAction<WarpTabConfigSettings>, settings: WarpTabConfigSettings): Promise<void> {
		const displayName = await getWarpTabConfigDisplayName(settings.tabConfig);
		await target.setTitle("");
		await target.setImage(renderWarpTabKey({ label: displayName }));
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, WarpTabConfigSettings>): Promise<void> {
		if (!isDataSourceRequest(ev.payload) || ev.payload.event !== TAB_CONFIG_DATA_SOURCE) {
			return;
		}

		let items: WarpTabConfigOption[];
		try {
			items = await listWarpTabConfigs();
		} catch (error) {
			streamDeck.logger.error("failed to list Warp Tab Configs", error);
			items = [];
		}

		try {
			await streamDeck.ui.sendToPropertyInspector({
				event: TAB_CONFIG_DATA_SOURCE,
				items: items.length > 0 ? items : EMPTY_OPTIONS
			});
		} catch (error) {
			streamDeck.logger.error("failed to send Warp Tab Config options", error);
		}
	}
}

function isDataSourceRequest(value: JsonValue): value is DataSourceRequest {
	return typeof value === "object" && value !== null && !Array.isArray(value) && "event" in value;
}
