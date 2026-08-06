import {
	action,
	SingletonAction,
	streamDeck,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type KeyAction,
	type WillAppearEvent
} from "@elgato/streamdeck";

import { renderWarpTabKey } from "../render";
import { normalizeWarpUri, openWarpUri } from "../warp/uris";

export type WarpUriSettings = {
	uri?: string;
};

/** Opens only explicitly validated Warp or Warp Preview custom URIs. */
@action({ UUID: "com.kadragon.aiusage.warp-uri" })
export class WarpUriLauncher extends SingletonAction<WarpUriSettings> {
	override async onWillAppear(ev: WillAppearEvent<WarpUriSettings>): Promise<void> {
		if (ev.action.isKey()) {
			await this.#refresh(ev.action, ev.payload.settings);
		}
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<WarpUriSettings>): Promise<void> {
		if (ev.action.isKey()) {
			await this.#refresh(ev.action, ev.payload.settings);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<WarpUriSettings>): Promise<void> {
		const uri = normalizeWarpUri(ev.payload.settings.uri);
		if (uri === undefined) {
			streamDeck.logger.error("Warp URI is invalid or uses an unsupported scheme");
			await ev.action.showAlert();
			return;
		}

		try {
			await openWarpUri(uri);
		} catch (error) {
			streamDeck.logger.error(`failed to open Warp URI: ${uri}`, error);
			await ev.action.showAlert();
		}
	}

	async #refresh(target: KeyAction<WarpUriSettings>, settings: WarpUriSettings): Promise<void> {
		const uri = normalizeWarpUri(settings.uri);
		try {
			await target.setTitle("");
			await target.setImage(renderWarpTabKey({ label: uri === undefined ? "WARP URI" : "WARP LINK" }));
		} catch (error) {
			streamDeck.logger.error("failed to render Warp URI key", error);
		}
	}
}
