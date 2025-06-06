# Translate Automation

This repository helps Flipbizz developers to automate the static keyword translation.

- Extracts all literals from your source code into a single JSON of keys, filter out blacklisted words
- Merges those keys into different JSON files that represent different languages
- Translates empty‐string entries in each JSON file using AWS Translate
- Updates `i18n.ts` with the newly translated key-value pairs

## Prerequisites
- Node.js v14+ and npm
- A valid AWS account with access to AWS Translate
- AWS credentials configured in `.env`


## Project Structure
```
translation/
├─ src/
│  ├─ componentName1/    # your .tsx/.ts/.js/.jsx files
|  ├─ componentName2/
|  ├─ componentName3/
│  └─ i18n.ts            # i18next initialization + `const resources = { … }`
│
├─ locales/              # JSON files for each language (e.g. en.json, fr.json, de.json)
│
├─ scripts/
│  ├─ config.ts          # ← centralized configuration (paths, globs, langs, AWS settings, blacklistPath)
│  ├─ blacklist.json     # ← list of words not to translate
│  ├─ extract.ts         # AST‐based extraction of static strings → temp/keys.json (filters blacklist)
│  ├─ merge.ts           # merge new keys from temp/keys.json into each locales/*.json
│  └─ translate.ts       # AWS Translate API calls & patching src/i18n.ts
│
├─ temp/                 # (auto‐created) holds keys.json from extract
│  └─ keys.json
│
├─ package.json
└─ tsconfig.json
```

## Dependency Installation
   ```bash
   npm install
   npm install --save-dev typescript ts-node prettier comment-json @babel/parser @babel/traverse fast-glob p-queue
   npm install aws-sdk
   ```

Ensure TypeScript is set up (`tsconfig.json` should include `scripts/**/*.ts` in its `include`).

## Script Summary
### `npm run extract`
Purpose: Gathers all text that needs translation
- Scans code files for any literal strings marked for translation (e.g. `t("…")`) and any visible text in JSX
- Remove potential blacklisted words
- Creates and saves a clean, sorted list of strings

### `npm run merge`
Purpose: Ensures every language file includes every piece of text you need to translate.  
- Looks at the list of phrases created
- Goes through each language’s JSON file (e.g. `locales/en.json`, `locales/fr.json`)
- Adds missing phrases as blank entries to be ready for translation.

### `npm run translate`
Purpose: Fills in the blank entries in language files with translations, and updates `i18n.ts`
- Finds all language JSON file and replace empty entries with translated text with AWS Translate
- Saves each language file with all the newly filled-in translations.  
- Takes the newly translated words and merges them back into `i18n.ts`
