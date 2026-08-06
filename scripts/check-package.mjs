import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(repoRoot, "com.kadragon.aiusage.sdPlugin");
const manifestPath = path.join(packageRoot, "manifest.json");
const failures = [];

function readJson(filePath, label) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		failures.push(`${label} is missing or invalid JSON`);
		return undefined;
	}
}

function requireFile(relativePath) {
	const filePath = path.join(packageRoot, relativePath);
	try {
		const stats = fs.statSync(filePath);
		if (!stats.isFile() || stats.size === 0) {
			failures.push(`${relativePath} is empty or not a regular file`);
		}
	} catch {
		failures.push(`${relativePath} is missing; run npm run build first`);
	}
}

const manifest = readJson(manifestPath, "manifest.json");
if (manifest !== undefined && manifest.CodePath !== "bin/plugin.js") {
	failures.push(`manifest.json CodePath must be bin/plugin.js (found ${String(manifest.CodePath)})`);
}

requireFile("bin/plugin.js");
requireFile("bin/package.json");

const generatedPackage = readJson(path.join(packageRoot, "bin", "package.json"), "bin/package.json");
if (generatedPackage !== undefined && generatedPackage.type !== "module") {
	failures.push("bin/package.json must declare type=module");
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`ERROR: ${failure}`);
	}
	process.exit(1);
}

console.log("Package checks passed (manifest and generated bundle are present).");
