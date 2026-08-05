import { ensureAgentEventDirectory, takeAgentEvents } from "./spool";
import type { AgentEvent } from "./types";

export type AgentEventListener = (event: AgentEvent) => void;

type MonitorOptions = {
	stateDirectory?: string;
	intervalMs?: number;
	onError?: (error: Error) => void;
};

/**
 * Polls the atomic event spool only while an Agent Attention key is visible.
 *
 * Polling is paired with atomic rename publication so the monitor never needs to observe or parse a
 * partially written JSON file, and it avoids relying on platform-specific fs.watch behavior.
 */
export class AgentAttentionMonitor {
	readonly #stateDirectory?: string;
	readonly #intervalMs: number;
	readonly #onError: (error: Error) => void;
	readonly #listeners = new Set<AgentEventListener>();
	#timer?: NodeJS.Timeout;
	#pollInFlight = false;
	#running = false;

	constructor(options: MonitorOptions = {}) {
		this.#stateDirectory = options.stateDirectory;
		this.#intervalMs = Math.max(100, options.intervalMs ?? 250);
		this.#onError = options.onError ?? (() => undefined);
	}

	subscribe(listener: AgentEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async start(): Promise<boolean> {
		if (this.#running) {
			return true;
		}

		this.#running = true;
		try {
			await ensureAgentEventDirectory(this.#stateDirectory);
			await this.#poll();
		} catch (error) {
			this.#running = false;
			throw error;
		}

		if (!this.#running) {
			return false;
		}

		this.#timer = setInterval(() => {
			this.#poll().catch((error: unknown) => this.#report(error));
		}, this.#intervalMs);
		return true;
	}

	stop(): void {
		this.#running = false;
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	async #poll(): Promise<void> {
		if (!this.#running || this.#pollInFlight) {
			return;
		}

		this.#pollInFlight = true;
		try {
			const result = await takeAgentEvents(this.#stateDirectory);
			for (const error of result.errors) {
				this.#report(error);
			}

			for (const event of result.events) {
				for (const listener of this.#listeners) {
					try {
						listener(event);
					} catch (error) {
						this.#report(error);
					}
				}
			}
		} finally {
			this.#pollInFlight = false;
		}
	}

	#report(error: unknown): void {
		this.#onError(error instanceof Error ? error : new Error(String(error)));
	}
}
