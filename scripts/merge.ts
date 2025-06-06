import fs from "fs";
import path from "path";
import config from "./config";
import { parse, stringify } from "comment-json";

type LocaleObject = Record<string, string>;

/**
 * Reads a JSON file from disk (using comment-json.parse to preserve any comments or formatting)
 * - If the file does not exist or is empty, returns an empty object
 * - Otherwise, parses the JSON content into a simple key→value map
 *
 * @param filePath - Full path to the locale JSON file (e.g., "locales/fr.json")
 * @returns LocaleObject – an object mapping each translation key to its value
 */
function loadLocaleFile(filePath: string): LocaleObject {
	if (!fs.existsSync(filePath)) {
		return {}; // File is missing → treat as empty
	}

	const raw = fs.readFileSync(filePath, "utf8").trim();
	if (!raw) {
		return {}; // File exists but is empty → treat as empty
	}

	try {
		// Parse with comment-json to preserve comments/formatting
		return parse(raw) as LocaleObject;
	} catch (err) {
		console.error(`❌ Failed to parse ${filePath}:`, err);
		process.exit(1);
	}
}

/**
 * Writes a given locale object back to disk as pretty‐printed JSON
 * - Uses comment-json.stringify to format with 2‐space indentation
 *
 * @param filePath - Full path where the JSON should be written (e.g., "locales/fr.json")
 * @param obj – The key→value map to serialize
 */
function saveLocaleFile(filePath: string, obj: LocaleObject) {
	const content = stringify(obj, null, 2) + "\n"; // Convert the object to a JSON string with 2‐space indentation
	fs.writeFileSync(filePath, content);
}

function main() {
	// 1) Read all extracted keys from temp/keys.json (created in the extract step)
	const keysPath = config.tempKeysPath;
	if (!fs.existsSync(keysPath)) {
		console.error(`❌ ${keysPath} not found. Did you run i18n:extract first?`);
		process.exit(1);
	}
	// Load the array of keys (strings) from JSON
	const allKeys: string[] = JSON.parse(fs.readFileSync(keysPath, "utf8"));

	// 2) Determine which locale files to update:
	let localeFiles: string[];
	if (config.languages.length > 0) {
		// If config.languages is not empty, explicitly use those language codes
		localeFiles = config.languages.map((lang) => `${lang}.json`);
	} else {
		// Otherwise, scan the entire localesDir for any "*.json" files
		if (!fs.existsSync(config.localesDir)) {
			console.error(
				`❌ localesDir "${config.localesDir}" not found. Please create it and add locale JSON files.`
			);
			process.exit(1);
		}
		localeFiles = fs
			.readdirSync(config.localesDir)
			.filter((f) => f.endsWith(".json"));
	}

	// 3) For each locale file, merge in any new keys (from allKeys) that are missing
	for (const filename of localeFiles) {
		const filePath = path.join(config.localesDir, filename);
		// Load existing translations (if file exists); otherwise get an empty object
		const localeObj = loadLocaleFile(filePath);

		let addedCount = 0;
		// For each key extracted earlier, if it's missing in this locale, add it with an empty string
		for (const key of allKeys) {
			if (!(key in localeObj)) {
				localeObj[key] = "";
				addedCount++;
			}
		}

		if (addedCount > 0) {
			// If we added any keys, write the updated JSON back to disk
			saveLocaleFile(filePath, localeObj);
			console.log(`🆕 [${filename}] Added ${addedCount} new key(s).`);
		} else {
			// Otherwise, log that nothing needed to be added
			console.log(`✅ [${filename}] No new keys to add.`);
		}
	}
}

main();