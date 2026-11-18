import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type HcDisplayMode = "running" | "waiting";

/** One address per counted session, including sessions without a usable address. */
export type HcAgentStatusReading = Record<HcDisplayMode, (string | undefined)[]>;

export function parseHcAgentStatus(output: string): HcAgentStatusReading {
	const response = JSON.parse(output);
	if (!Array.isArray(response?.terminals)) {
		throw new Error("Invalid HC terminal list");
	}

	const reading: HcAgentStatusReading = { running: [], waiting: [] };
	for (const terminal of response.terminals) {
		if (terminal?.state !== "live" && terminal?.state !== "finished") {
			throw new Error("Invalid HC terminal state");
		}
		if (terminal.state === "finished" || terminal.status == null) {
			continue;
		}
		const address = typeof terminal.address === "string" ? terminal.address.trim() || undefined : undefined;
		switch (terminal.status) {
			case "working":
				reading.running.push(address);
				break;
			case "blocked":
			case "idle":
			case "done":
				reading.waiting.push(address);
				break;
			case "error":
				break;
			default:
				throw new Error("Invalid HC terminal status");
		}
	}
	return reading;
}

export async function readHcAgentStatus(): Promise<HcAgentStatusReading> {
	return parseHcAgentStatus(await runHerdrCli("hc", "herdr-core", ["ls", "--json"]));
}

export async function focusHcAgent(address: string): Promise<void> {
	await runHerdrCli("herdr-app", "herdr-app", ["do", "agent.focus", "--terminal", address]);
}

async function runHerdrCli(command: string, installDirectory: string, args: string[]): Promise<string> {
	const options = { timeout: 4000, windowsHide: true };
	try {
		const { stdout } = await execute(command, args, options);
		return stdout;
	} catch (error) {
		const localAppData = process.env.LOCALAPPDATA;
		if (process.platform !== "win32" || !localAppData || (error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		// Stream Deck can inherit an older PATH than an interactive shell.
		const executable = join(localAppData, "Programs", installDirectory, `${command}.exe`);
		const { stdout } = await execute(executable, args, options);
		return stdout;
	}
}
