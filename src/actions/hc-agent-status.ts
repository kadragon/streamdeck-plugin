import { action, SingletonAction, streamDeck, type WillAppearEvent } from "@elgato/streamdeck";

import { readHcAgentCounts } from "../hc/status";
import { renderHcAgentKey } from "../render";

const REFRESH_INTERVAL_MS = 5000;

@action({ UUID: "com.kadragon.aiusage.hc-agent-status" })
export class HcAgentStatus extends SingletonAction {
	#ticker?: NodeJS.Timeout;
	#refreshing?: Promise<void>;

	override async onWillAppear(event: WillAppearEvent): Promise<void> {
		if (event.action.isKey()) {
			await event.action.setTitle("").catch((error) => streamDeck.logger.error("HC key title update failed", error));
		}
		if ([...this.actions].length > 0) {
			this.#ticker ??= setInterval(() => {
				this.refreshAll().catch((error) => streamDeck.logger.error("HC status tick failed", error));
			}, REFRESH_INTERVAL_MS);
		}
		await this.refreshAll();
	}

	override onWillDisappear(): void {
		if ([...this.actions].length === 0) {
			clearInterval(this.#ticker);
			this.#ticker = undefined;
		}
	}

	override onKeyDown(): Promise<void> {
		return this.refreshAll();
	}

	async refreshAll(): Promise<void> {
		if ([...this.actions].length === 0) {
			return;
		}
		this.#refreshing ??= this.#refresh().finally(() => {
			this.#refreshing = undefined;
		});
		await this.#refreshing;
	}

	async #refresh(): Promise<void> {
		const counts = await readHcAgentCounts().catch((error: NodeJS.ErrnoException) => {
			// Do not log subprocess output, which can include terminal metadata.
			streamDeck.logger.debug("HC terminal list unavailable", error.code ?? error.name);
			return undefined;
		});
		const image = renderHcAgentKey(counts);
		const results = await Promise.allSettled([...this.actions].map((visible) => (
			visible.isKey() ? visible.setImage(image) : undefined
		)));
		for (const result of results) {
			if (result.status === "rejected") {
				streamDeck.logger.error("HC status render failed", result.reason);
			}
		}
	}
}
