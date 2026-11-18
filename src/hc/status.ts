import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type HcAgentCounts = {
	working: number;
	waiting: number;
};

export function parseHcAgentCounts(output: string): HcAgentCounts {
	const response = JSON.parse(output);
	if (!Array.isArray(response?.terminals)) {
		throw new Error("Invalid HC terminal list");
	}

	const counts: HcAgentCounts = { working: 0, waiting: 0 };
	for (const terminal of response.terminals) {
		if (terminal?.state !== "live" && terminal?.state !== "finished") {
			throw new Error("Invalid HC terminal state");
		}
		if (terminal.state === "finished" || terminal.status == null) {
			continue;
		}
		switch (terminal.status) {
			case "working":
				counts.working++;
				break;
			case "blocked":
				counts.waiting++;
				break;
			case "idle":
			case "done":
			case "error":
				break;
			default:
				throw new Error("Invalid HC terminal status");
		}
	}
	return counts;
}

export async function readHcAgentCounts(): Promise<HcAgentCounts> {
	const args = ["ls", "--json"];
	const options = { timeout: 4000, windowsHide: true };
	try {
		const { stdout } = await execute("hc", args, options);
		return parseHcAgentCounts(stdout);
	} catch (error) {
		const localAppData = process.env.LOCALAPPDATA;
		if (process.platform !== "win32" || !localAppData || (error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		// Stream Deck can inherit an older PATH than an interactive shell.
		const executable = join(localAppData, "Programs", "herdr-core", "hc.exe");
		const { stdout } = await execute(executable, args, options);
		return parseHcAgentCounts(stdout);
	}
}
