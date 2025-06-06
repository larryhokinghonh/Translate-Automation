import fs from "fs";
import path from "path";
import PQueue from "p-queue";
import config from "./config";
import { Translate } from "aws-sdk";
import { parse as parseCommentJson } from "comment-json";
import "dotenv/config";

/**
 * Loads a JSON file from disk into a simple key→value map
 * - If the file does not exist or is empty, returns an empty object
 * - Otherwise, parses the JSON content into a Record<string,string>
 *
 * @param filepath - Full path to the locale JSON file (e.g., "locales/fr.json")
 * @returns Record<string,string> representing existing translations (or an empty object)
 */
function loadLocaleJson(filepath: string): Record<string, string> {
	if (!fs.existsSync(filepath)) {
		console.warn(`⚠️  File not found: ${filepath}. Treating as empty object.`);
		return {};
	}
	const raw = fs.readFileSync(filepath, "utf8").trim();
	if (!raw) {
		console.warn(`⚠️  File is empty: ${filepath}. Treating as empty object.`);
		return {};
	}
	try {
		return JSON.parse(raw) as Record<string, string>;
	} catch (err) {
		console.error(`❌ Failed to parse JSON at ${filepath}:`, err);
		process.exit(1);
	}
}

/**
 * Writes a given key→value map back to disk as pretty-printed JSON
 * - Uses 2-space indentation and appends a newline for readability
 *
 * @param filepath - Full path where the JSON should be written (e.g., "locales/fr.json")
 * @param obj – The key→value map containing translations to save
 */
function saveLocaleJson(filepath: string, obj: Record<string, string>) {
	const content = JSON.stringify(obj, null, 2) + "\n";
	fs.writeFileSync(filepath, content);
}

/**
 * Given a filename like "fr.json", returns the language code "fr"
 * - Strips off the ".json" extension
 *
 * @param filename - Name of the JSON file (including extension)
 * @returns Two-letter (or multi-part) language code without ".json"
 */
function langCodeFromFilename(filename: string): string {
	return path.basename(filename, ".json");
}

/**
 * Translates all keys in a single locale JSON whose values are empty ("" or whitespace)
 * - Loads the JSON into memory
 * - Collects every key where the value is missing or blank
 * - Uses AWS Translate (with concurrency via PQueue) to translate each key from English into the target language
 * - Replaces the blank values with the translated text
 * - Saves the updated JSON back to disk
 *
 * @param localesDir - Path to the folder containing locale JSON files
 * @param filename - The specific file to translate (e.g., "fr.json")
 * @param awsRegion - AWS region to configure Translate client
 * @param concurrency - Maximum number of parallel Translate requests
 * @returns Promise resolving to the updated dictionary for that language
 */
async function translateSingleLocale(
	localesDir: string,
	filename: string,
	awsRegion: string,
	concurrency: number
): Promise<Record<string, string>> {
	const filePath = path.join(localesDir, filename);
	const langCode = langCodeFromFilename(filename);

	console.log(`\n=== Translating locale: ${filename} (lang="${langCode}") ===`);

	// Load existing translations (or an empty object if none)
	const localeData = loadLocaleJson(filePath);
	const keysToTranslate: string[] = [];

	// 1) Collect every key whose value is empty or whitespace
	for (const [key, val] of Object.entries(localeData)) {
		if (val == null || val.trim().length === 0) {
			keysToTranslate.push(key);
		}
	}

	if (keysToTranslate.length === 0) {
		console.log(`✅ [${langCode}] No empty‐string keys to translate.`);
		return localeData;
	}

	console.log(`🧐 [${langCode}] Found ${keysToTranslate.length} key(s) to translate:`);
	keysToTranslate.forEach((k) => console.log(`   • "${k}"`));

	// 2) Create an AWS Translate client for the given region
	const translateClient = new Translate({ region: awsRegion });

	// 3) Use PQueue to limit concurrent translation requests
	const queue = new PQueue({ concurrency });

	for (const engString of keysToTranslate) {
		queue.add(async () => {
			try {
				// Call AWS TranslateText for each string
				const resp = await translateClient
					.translateText({
						SourceLanguageCode: "en",
						TargetLanguageCode: langCode,
						Text: engString,
					})
					.promise();

				const translated = resp.TranslatedText as string;
				localeData[engString] = translated;
				console.log(`🔤 [${langCode}] "${engString}" → "${translated}"`);
			} catch (err) {
				console.error(`❌ [${langCode}] Error translating "${engString}":`, err);
			}
		});
	}

	// 4) Wait for all queued translation jobs to finish
	await queue.onIdle();

	// 5) Write the updated JSON back to disk
	saveLocaleJson(filePath, localeData);
	console.log(`💾 [${langCode}] Wrote ${filePath} (${keysToTranslate.length} translated)`);

	return localeData;
}

/**
 * Finds and translates all locale JSON files under the configured directory (or only those explicitly listed)
 * - Determines which files to process based on config.languages or by scanning config.localesDir
 * - Calls translateSingleLocale for each file in sequence
 * - Collects and returns a map of language code → updated dictionary for later use when patching i18n.ts
 *
 * @returns Promise resolving to a map { <langCode>: Record<string,string> } of all updated translations
 */
async function translateAllLocales(): Promise<Record<string, Record<string, string>>> {
	const localesDir = config.localesDir;
	if (!fs.existsSync(localesDir)) {
		console.error(`❌ "${localesDir}" does not exist. Create it and add some .json files.`);
		process.exit(1);
	}

	// Determine which JSON filenames to process
	let localeFiles: string[];
	if (config.languages.length > 0) {
		// If languages are explicitly listed, use those (e.g., ["en","fr"] → ["en.json","fr.json"])
		localeFiles = config.languages.map((lang) => `${lang}.json`);
	} else {
		// Otherwise, auto-discover all "*.json" under config.localesDir
		localeFiles = fs.readdirSync(localesDir).filter((f) => f.endsWith(".json"));
	}

	const result: Record<string, Record<string, string>> = {};
	for (const filename of localeFiles) {
		const langCode = langCodeFromFilename(filename);
		const updatedDict = await translateSingleLocale(
			localesDir,
			filename,
			config.aws.region,
			config.aws.concurrency
		);
		result[langCode] = updatedDict;
	}
	return result;
}

/**
 * Creates or updates a TypeScript snippet for a given language block inside src/i18n.ts
 * - Reads src/i18n.ts and looks for an existing block for langCode (under resources → translation)
 * - If it finds one, parses its inner object and merges in any newly translated keys
 * - If not, it will generate a new block from scratch
 * - Returns a string that looks like:
 *     fr: {
 *       translation: {
 *         "Hello": "Bonjour",
 *         "Sign In": "Se connecter",
 *         // …
 *       }
 *     },
 *
 * @param langCode - Two-letter or multi-part code (like "fr" or "pt-BR")
 * @param newDict - Newly translated key→value pairs for that language
 * @returns A TS-formatted snippet to replace or insert under resources in i18n.ts
 */
function buildMergedLanguageBlock(
	langCode: string,
	newDict: Record<string, string>
): string {
	const i18nPath = config.i18nTsPath;
	const fileContent = fs.readFileSync(i18nPath, "utf8");

	// Pattern to capture an existing block for langCode and extract its inner object
	const blockPattern = new RegExp(
		`${langCode}\\s*:\\s*\\{[\\s\\S]*?translation\\s*:\\s*\\{([\\s\\S]*?)\\}\\s*\\}[,]?`,
		"m"
	);

	let existingDict: Record<string, string> = {};
	const match = blockPattern.exec(fileContent);

	if (match && match[1]) {
		// match[1] holds everything inside "translation: { … }"
		const innerContent = match[1].trim();
		const toParse = `{${innerContent}}`;

		try {
			// Parse out the existing key→value map
			existingDict = parseCommentJson(toParse) as Record<string, string>;
		} catch (err) {
			console.warn(
				`⚠️  Could not parse existing "${langCode}" translation block. Starting fresh.`
			);
			existingDict = {};
		}
	}

	// Merge new translations into existing ones (only overwrite keys that are empty or missing)
	const merged: Record<string, string> = { ...existingDict };
	for (const [key, val] of Object.entries(newDict)) {
		if (!merged[key] || merged[key].trim().length === 0) {
			merged[key] = val;
		}
	}

	// Build the TS snippet
	let block = `${langCode}: {\n  translation: {\n`;
	for (const [key, value] of Object.entries(merged)) {
		const safeKey = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const safeValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		block += `    "${safeKey}": "${safeValue}",\n`;
	}
	block += `  }\n},`;

	return block;
}

/**
 * Replaces or inserts a given language block in src/i18n.ts under the `resources` object
 * - If a block for langCode already exists, it is replaced with the merged snippet from buildMergedLanguageBlock
 * - If not, it finds the closing brace of `resources = { ... }` and inserts a new block before it
 *
 * @param langCode - Language code (e.g., "fr", "de")
 * @param newDict - Newly translated key→value map for that language
 */
function updateSingleLanguageInI18n_Merge(
	langCode: string,
	newDict: Record<string, string>
) {
	const i18nPath = config.i18nTsPath;
	const original = fs.readFileSync(i18nPath, "utf8");
	const newBlock = buildMergedLanguageBlock(langCode, newDict);

	// Pattern to match an existing language block including its trailing comma
	const patternExisting = new RegExp(`${langCode}\\s*:\\s*\\{[\\s\\S]*?\\},`, "m");

	if (patternExisting.test(original)) {
		// Replace existing block in place
		const updated = original.replace(patternExisting, newBlock + "\n");
		fs.writeFileSync(i18nPath, updated, "utf8");
		console.log(`✅ Merged updates into existing "${langCode}" block in ${i18nPath}`);
		return;
	}

	// If the block did not exist, insert newBlock under resources = { ... }
	const resourcesOpenPattern = /const\s+resources\s*=\s*\{\s*/;
	const matchOpen = resourcesOpenPattern.exec(original);
	if (!matchOpen) {
		console.error(`❌ Could not find “const resources = {” in ${i18nPath}`);
		process.exit(1);
	}

	// Find the closing brace that matches the opening `{`
	const startIndex = matchOpen.index + matchOpen[0].length;
	let braceCount = 1;
	let insertPos = -1;

	for (let i = startIndex; i < original.length; i++) {
		const ch = original[i];
		if (ch === "{") {
			braceCount++;
		} else if (ch === "}") {
			braceCount--;
			if (braceCount === 0) {
				insertPos = i;
				break;
			}
		}
	}
	if (insertPos < 0) {
		console.error(`❌ Could not find matching closing brace for resources in ${i18nPath}`);
		process.exit(1);
	}

	// Insert newBlock (indented) just before the closing brace
	const before = original.slice(0, insertPos);
	const after = original.slice(insertPos);
	const updatedFile = `${before}  ${newBlock}\n${after}`;
	fs.writeFileSync(i18nPath, updatedFile, "utf8");
	console.log(`✅ Inserted new "${langCode}" block into ${i18nPath}`);
}

/**
 * Coordinates the entire translation process:
 * 1. Calls translateAllLocales to fill in blank entries in each locale JSON on disk
 * 2. For each language that was translated, merges or inserts that block into src/i18n.ts
 * 3. Logs progress and handles any fatal errors
 */
async function main() {
	// STEP 1: Translate all locale JSONs on disk, returning a map { langCode: updatedDict }
	const allTranslations = await translateAllLocales();
	// STEP 2: For each language, update src/i18n.ts accordingly
	for (const [langCode, newDict] of Object.entries(allTranslations)) {
		updateSingleLanguageInI18n_Merge(langCode, newDict);
	}
}

main().catch((err) => {
	console.error("🐛 Fatal error in translate.ts:", err);
	process.exit(1);
});
