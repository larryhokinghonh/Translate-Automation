import fg from "fast-glob";
import fs from "fs";
import path from "path";
import traverse from "@babel/traverse";
import config from "./config";
import { parse } from "@babel/parser";
import type { StringLiteral } from "@babel/types";

/**
 * Reads a JSON file at `blacklistPath` (if it exists) and returns a Set of strings
 * representing keys that should be ignored during extraction
 *
 * @param blacklistPath - Path to the JSON file containing an array of blacklisted strings
 * @returns Set<string> of blacklisted keys (empty if file missing or parse error)
 */
function loadBlacklist(blacklistPath: string): Set<string> {
	if (!fs.existsSync(blacklistPath)) {
		return new Set(); // If the file doesn’t exist, return an empty Set.
	}
	try {
		const raw = fs.readFileSync(blacklistPath, "utf8");
		const arr: string[] = JSON.parse(raw);
		return new Set(arr);
	} catch (e) {
		console.warn(`⚠️  Could not parse blacklist at ${blacklistPath}; ignoring.`); // If parsing fails, log a warning and return an empty Set
		return new Set();
	}
}

/**
 * Parses a single source file with Babel, traverses its AST, and collects:
 * - Any literal passed into a function call named `t("…")`
 * - Any non-empty JSX text nodes
 *
 * @param file - File path to parse
 * @returns Promise<string[]> - Array of unique strings found in that file
 */
async function extractStringsFromFile(file: string): Promise<string[]> {
	const src = fs.readFileSync(file, "utf8");
	const ast = parse(src, {
		sourceType: "module",
		plugins: ["typescript", "jsx"],
	});

	const keys = new Set<string>();

	// Finds calls like t("Some text") and adds the literal to `keys`
	traverse(ast, {
		CallExpression({ node }) {
			if (
				node.callee.type === "Identifier" &&
				node.callee.name === "t" &&
				node.arguments[0]?.type === "StringLiteral"
			) {
				keys.add((node.arguments[0] as StringLiteral).value);
			}
		},

		// Finds any non-empty string inside JSX (e.g. <div>Hello</div>) and adds it
		JSXText({ node }) {
			const val = node.value.trim();
			if (val) keys.add(val);
		},
	});

	return [...keys];
}

/**
 * Orchestrates the extraction process:
 *   1. Uses `fast-glob` to find all source files matching `config.sourceGlobs`
 *   2. Calls `extractStringsFromFile` on each to gather all literal strings
 *   3. Loads a blacklist (if any) and removes those keys from the set
 *   4. Ensures the output directory for `tempKeysPath` exists
 *   5. Writes the sorted, filtered list of keys to `config.tempKeysPath`
 */
async function main() {
	// 1) Find all files to parse, based on globs in config.sourceGlobs
	const files = await fg(config.sourceGlobs);
	const allKeys = new Set<string>();

	// 2) Extract static strings from each matched file
	for (const file of files) {
		const keysInFile = await extractStringsFromFile(file);
		keysInFile.forEach((k) => allKeys.add(k));
	}

	// 3) Load blacklist and remove any blacklisted keys
	const blacklist = loadBlacklist(config.blacklistPath);
	for (const badKey of blacklist) {
		if (allKeys.delete(badKey)) {
			console.log(`🛑  Blacklisted key removed: "${badKey}"`);
		}
	}

	// 4) Ensure the directory for tempKeysPath exists
	const tempDir = path.dirname(config.tempKeysPath);
	if (tempDir && !fs.existsSync(tempDir)) {
		fs.mkdirSync(tempDir, { recursive: true });
	}

	// 5) Write out the sorted list of keys to tempKeysPath
	fs.writeFileSync(
		config.tempKeysPath,
		JSON.stringify([...allKeys].sort(), null, 2)
	);
	console.log(`✂️  Extracted ${allKeys.size} keys to ${config.tempKeysPath}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});