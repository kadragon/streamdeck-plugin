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
	if (relativePath.includes(path.join("src", "usage")) && /new Date\(\)/.test(content)) {
		failures.push({
			message: relativePath + " contains a no-argument Date fallback",
			fix: "Use the source timestamp and reject unusable values at the reader boundary.",
			ref: "docs/conventions.md"
		});
	}
}

requireText(
	"src/usage/codex-api.ts",
	/new EnvHttpProxyAgent\(\{[^}]*allowH2:\s*false/,
	"Codex usage dispatcher does not pin HTTP/1.1 with allowH2: false",
	"Keep allowH2: false. Rollup's CommonJS interop breaks undici's node:http2 binding, so a bundled h2 request fails with 'http2.connect is not a function' and the plugin falls back to rollouts forever. Unit tests inject fetchImpl and cannot catch it.",
	"docs/architecture.md"
);
requireText(
	"src/usage/claude.ts",
	/(Number\.isFinite\(weekly\.used_percentage\)|isUsagePercent\(weekly\?\.used_percentage\))/,
	"Claude reader does not guard used_percentage with Number.isFinite",
	"Reject null, NaN, and Infinity before constructing UsageReading.",
	"docs/conventions.md"
);
requireText(
	"src/usage/claude.ts",
	/(Number\.isNaN\(observedAt\.getTime\(\)\)|parseUsageTimestamp\(snapshot\?\.updated_at\))/,
	"Claude reader does not reject an unusable observedAt timestamp",
	"Drop readings without a usable source timestamp instead of defaulting to epoch or now.",
	"docs/conventions.md"
);
requireText(
	"src/usage/codex.ts",
	/(Number\.isFinite\(weekly\.used_percent\)|isUsagePercent\(weekly\?\.used_percent\))/,
	"Codex reader does not guard used_percent with Number.isFinite",
	"Reject null, NaN, and Infinity before constructing UsageReading.",
	"docs/conventions.md"
);
requireText(
	"src/usage/codex.ts",
	/(Number\.isNaN\(at\.getTime\(\)\)|parseUsageTimestamp\(record\?\.timestamp\))/,
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
	if (!(Number(parsed.Nodejs?.Version) >= 24)) {
		failures.push({
			message: "Stream Deck manifest does not pin Node.js 24 or newer",
			fix: "Keep Nodejs.Version at 24 or higher: the bundle statically imports node:sqlite through undici, and an older runtime fails to load the whole plugin with ERR_UNKNOWN_BUILTIN_MODULE.",
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
