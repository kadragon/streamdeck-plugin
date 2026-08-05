import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function read(relativePath) {
	const absolutePath = path.join(repoRoot, relativePath);
	try {
		return fs.readFileSync(absolutePath, "utf8");
	} catch {
		failures.push({
			message: relativePath + " is missing or unreadable",
			fix: "Restore " + relativePath + " before changing the dependent behavior.",
			ref: "docs/runbook.md"
		});
		return "";
	}
}

function requireText(relativePath, pattern, message, fix, ref = "AGENTS.md") {
	const content = read(relativePath);
	if (!pattern.test(content)) {
		failures.push({ message, fix, ref });
	}
}

function collectTypeScript(directory) {
	const files = [];
	for (const entry of fs.readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
		const relativePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectTypeScript(relativePath));
		} else if (entry.name.endsWith(".ts")) {
			files.push(relativePath);
		}
	}
	return files;
}

const sourceFiles = collectTypeScript("src");
for (const relativePath of sourceFiles) {
	const content = read(relativePath);
	if (/\b(?:fetch|axios)\s*\(|\b(?:http|https)\.request\s*\(|\bnet\.connect\s*\(/.test(content)) {
		failures.push({
			message: relativePath + " introduces a network client call",
			fix: "Read local tool files through the existing usage-reader boundary; do not add API/network access.",
			ref: "docs/architecture.md"
		});
	}
	if (relativePath.includes(path.join("src", "usage")) && /new Date\(\)/.test(content)) {
		failures.push({
			message: relativePath + " contains a no-argument Date fallback",
			fix: "Use the source timestamp and reject unusable values at the reader boundary.",
			ref: "docs/conventions.md"
		});
	}
}

requireText(
	"src/usage/claude.ts",
	/Number\.isFinite\(weekly\.used_percentage\)/,
	"Claude reader does not guard used_percentage with Number.isFinite",
	"Reject null, NaN, and Infinity before constructing UsageReading.",
	"docs/conventions.md"
);
requireText(
	"src/usage/claude.ts",
	/Number\.isNaN\(observedAt\.getTime\(\)\)/,
	"Claude reader does not reject an unusable observedAt timestamp",
	"Drop readings without a usable source timestamp instead of defaulting to epoch or now.",
	"docs/conventions.md"
);
requireText(
	"src/usage/codex.ts",
	/Number\.isFinite\(weekly\.used_percent\)/,
	"Codex reader does not guard used_percent with Number.isFinite",
	"Reject null, NaN, and Infinity before constructing UsageReading.",
	"docs/conventions.md"
);
requireText(
	"src/usage/codex.ts",
	/Number\.isNaN\(at\.getTime\(\)\)/,
	"Codex reader does not reject an unusable observation timestamp",
	"Drop observations without a usable timestamp; never date them to now.",
	"docs/conventions.md"
);
requireText(
	"src/plugin.ts",
	/refreshAll\(\)\.catch\(/,
	"Wake-up refresh does not handle rejected promises",
	"Catch and log refreshAll() failures at the SDK callback boundary.",
	"docs/architecture.md"
);
requireText(
	"src/actions/weekly-limit.ts",
	/this\.#tick\(\)\.catch\(/,
	"Ticker callback does not handle rejected promises",
	"Catch and log ticker failures so one failed refresh cannot terminate the plugin.",
	"docs/architecture.md"
);
requireText(
	"scripts/statusline-usage-snapshot.sh",
	/\$SNAPSHOT\.\$\$\.tmp/,
	"Status-line snapshot does not use a process-specific temporary path",
	"Write to a pid-scoped temp file and publish atomically with mv.",
	"docs/conventions.md"
);
requireText(
	"scripts/statusline-usage-snapshot.sh",
	/\$HISTORY\.\$\$\.tmp/,
	"Status-line history trim does not use a process-specific temporary path",
	"Write the trimmed history to a pid-scoped temp file before replacing it.",
	"docs/conventions.md"
);

// The hook writer cannot import the TypeScript spool, so its TTL is a mirrored literal. Reader and
// both writers must agree, or events are pruned before or after they stop being applied.
const spoolSource = read("src/agent-attention/spool.ts");
const hookSource = read("scripts/agent-event.mjs");

const ttlPattern = /const EVENT_TTL_MS = ([^;]+);/;
const spoolTtl = ttlPattern.exec(spoolSource)?.[1];
const hookTtl = ttlPattern.exec(hookSource)?.[1];
if (spoolTtl === undefined || hookTtl === undefined || spoolTtl !== hookTtl) {
	failures.push({
		message: "Agent-attention event TTL differs between src/agent-attention/spool.ts and scripts/agent-event.mjs",
		fix: "Keep both EVENT_TTL_MS declarations textually identical; spool.ts owns the value.",
		ref: "docs/conventions.md"
	});
}

// Both writers prune by parsing the epoch prefix out of their own file names. A pattern that drifts
// on one side silently stops pruning there, or starts deleting files the other side still owns.
const spoolNamePattern = /const match = (\/\^.+\/)\.exec\(name\);/.exec(spoolSource)?.[1];
const hookNamePattern = /const match = (\/\^.+\/)\.exec\(name\);/.exec(hookSource)?.[1];
if (spoolNamePattern === undefined || hookNamePattern === undefined || spoolNamePattern !== hookNamePattern) {
	failures.push({
		message: "Spool file-name pattern differs between src/agent-attention/spool.ts and scripts/agent-event.mjs",
		fix: "Keep both parseEventCreationTime patterns textually identical; spool.ts owns the naming contract.",
		ref: "docs/conventions.md"
	});
}

const manifestPath = "com.kadragon.aiusage.sdPlugin/manifest.json";
const manifest = read(manifestPath);
try {
	const parsed = JSON.parse(manifest);
	if (parsed.CodePath !== "bin/plugin.js") {
		failures.push({
			message: "Stream Deck manifest CodePath is not bin/plugin.js",
			fix: "Keep the manifest pointed at Rollup's generated bundle.",
			ref: "docs/architecture.md"
		});
	}
	if (!Array.isArray(parsed.Actions) || parsed.Actions.length === 0) {
		failures.push({
			message: "Stream Deck manifest declares no actions",
			fix: "Declare at least one packaged action before linking the plugin.",
			ref: "docs/runbook.md"
		});
	}
} catch {
	failures.push({
		message: manifestPath + " is not valid JSON",
		fix: "Repair manifest.json and run npm run check:principles again.",
		ref: "docs/runbook.md"
	});
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error("ERROR: " + failure.message + "\n  FIX: " + failure.fix + "\n  REF: " + failure.ref);
	}
	process.exit(1);
}

console.log("Principle checks passed (" + sourceFiles.length + " TypeScript source files scanned).");
