export interface I18nConfig {
	sourceGlobs: string[]; 						   
	tempKeysPath: string; 						   
	localesDir: string; 						   
	languages: string[]; 						   
	i18nTsPath: string; 						   
	blacklistPath: string; 						   
	aws: {
		region: string; 						   
		concurrency: number; 					   
	};
}

const config: I18nConfig = {
	sourceGlobs: ["src/**/*.{ts,tsx,js,jsx}"],     // Which source files to scan (TS/TSX/JS/JSX under src/)
	tempKeysPath: "temp/keys.json",   			   // Where to write the extracted keys JSON
	localesDir: "locales", 						   // Where the locale JSON files live
	languages: ["de", "es", "fr"], 				   // If you want to explicitly list languages, put them here. Otherwise, leave empty to auto-discover.
	i18nTsPath: "src/i18n.ts", 					   // Where your i18n TypeScript module lives (it has "const resources = { ... }")
	blacklistPath: "scripts/blacklist.json",

	aws: {
		region: process.env.AWS_REGION || "",
		concurrency: 5,
	},
};

export default config;
