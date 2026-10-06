import type { ImplementerWriteMode } from '../../../core/schemas/implementer-config.js';
import type { BuildOutputContract } from '../../implementers/file-bundle.js';
import { buildLanguageContext, type LanguageContext } from './language-context.js';

export function workspaceRules(dir: string): string {
  return `- Stay inside ${dir}: read, search, write and run shell commands only there, and never look for other copies of the project
- Use git only to read (status, diff, log, show); never commit, branch, tag, checkout, switch, stash, reset, restore, rebase, merge, add, or change git config or hooks
- Dependencies are already installed; never run a package-manager install, ci, add, remove or update (npm, pnpm, yarn, bun)`;
}

export const IMPLEMENTER_RUNS_NO_GATES =
  "SPLITBRIEF runs the project's typecheck, lint and test gates after you hand back, and its verdict is the authority. Run no test, typecheck, lint, format, screenshot, render or other gate command, not even the tests you write or a command the brief names.";

export function buildImplementerSystemPreamble(
  languageContext: LanguageContext,
  writesFiles: ImplementerWriteMode,
  isolationDir: string,
  outputContract?: BuildOutputContract | undefined,
  inPlace = false,
): string {
  if (outputContract === 'file-bundle-v1') return buildFileBundlePreamble(languageContext);
  if (writesFiles === 'extracted-code') return buildSystemPreamble(languageContext);

  const where = inPlace
    ? "directly in the user's checkout. Your edits land in the user's project as you make them."
    : "directly in the isolation directory. Your changes are promoted into the user's project afterwards.";
  return `SYSTEM: You are a coding agent for ${languageContext.language}. You write clean, working code ${where}
Rules:
${workspaceRules(isolationDir)}
- Start from the files the Task Brief suggests. If the change needs another project file (a caller, a test, a shared component), edit it and name it in your report with the reason. Never edit dependency manifests, lockfiles, CI configuration, env or key files, .git or .splitbrief unless the brief explicitly asks for that operation.
- Do NOT add comments unless specified in the task
- Use ${languageContext.importConvention}
- Follow the exact function signatures provided
- Stop and report rather than guessing when the brief's stop conditions are met, or when the target file's current content contradicts the brief
- The Task Brief inlines the read-only code of the context files it lists. Read the files it suggests before you edit them, and search only for a symbol the brief names.
- ${IMPLEMENTER_RUNS_NO_GATES} Do not run repeated git diffs.
- Report deviations as decisions with what and why; use [] when none.
- End your reply with ONE JSON object and nothing after it: {"status":"done","filesChanged":["<file>"],"touchedNotSuggested":[{"file":"<file>","reason":"<reason>"}],"notes":null,"decisions":[]}. If the brief cannot be completed without a file it does not provide, end with {"status":"blocked","question":"<question>","filesNeeded":["<file>"]} instead. Prose before the object is fine; text after it is not.

Example: {"status":"done","filesChanged":["src/hello.ts"],"touchedNotSuggested":[],"notes":null,"decisions":[]}`;
}

function preambleIntro(ctx: LanguageContext): string {
  return ctx.language === 'the project language'
    ? 'SYSTEM: You are a code generator for the project language. You write clean, working code that matches the target file.'
    : `SYSTEM: You are a ${ctx.language} code generator. You write clean, working ${ctx.language} code.`;
}

/**
 * The `file-bundle-v1` grammar: one JSON object carrying either the complete
 * contents of every declared file the answer changes or a blocked request for
 * the files the brief does not provide. The brief's own files are the only
 * paths the files form may name, and the response text never picks the grammar.
 */
function buildFileBundlePreamble(ctx: LanguageContext): string {
  return `${preambleIntro(ctx)}
Rules:
- Answer with ONE JSON object and nothing else: {"version":1,"files":[{"path":"...","action":"create"|"modify","content":"..."}]}
- When the brief cannot be completed without a file it does not provide, answer with {"version":1,"blocked":{"question":"...","filesNeeded":["..."]}} instead of the files form; the two forms never mix
- Do NOT include prose, explanations or markdown code fences
- "path" is one of the files the Task Brief declares, spelled exactly as the brief spells it; never another file
- "action" is "modify" for a file the brief shows under Current Code, "create" for one that does not exist yet
- "content" is that file's complete new text, never a fragment, a patch or a placeholder
- List only the files you change; leave every file you did not change out of the object
- Do NOT add comments unless specified in the task
- Use ${ctx.importConvention}
- Follow the exact function signatures provided`;
}

export function buildSystemPreamble(languageContext?: LanguageContext): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const example = exampleOutput(ctx);

  return `${preambleIntro(ctx)}
Rules:
- Output ONLY the complete file contents
- Do NOT include markdown code fences
- Do NOT include explanations before or after the code
- Do NOT add comments unless specified in the task
- Use ${ctx.importConvention}
- Follow the exact function signatures provided${example}`;
}

function exampleOutput(ctx: LanguageContext): string {
  switch (ctx.language) {
    case 'TypeScript':
      return `

Example output for a typical task:

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './types.js';

export function loadConfig(dir: string): Config {
  const filePath = join(dir, 'config.json');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return {
    name: parsed.name ?? 'default',
    version: parsed.version ?? '1.0.0',
  };
}`;
    case 'JavaScript':
      return `

Example output for a typical task:

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadConfig(dir) {
  const filePath = join(dir, 'config.json');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return {
    name: parsed.name ?? 'default',
    version: parsed.version ?? '1.0.0',
  };
}`;
    case 'Python':
      return `

Example output for a typical task:

import json
from pathlib import Path


def load_config(directory: str) -> dict[str, str]:
    file_path = Path(directory) / "config.json"
    raw = file_path.read_text(encoding="utf-8")
    parsed = json.loads(raw)
    return {
        "name": parsed.get("name", "default"),
        "version": parsed.get("version", "1.0.0"),
    }`;
    case 'Go':
      return `

Example output for a typical task:

package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func LoadConfig(dir string) (map[string]string, error) {
	path := filepath.Join(dir, "config.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var parsed map[string]string
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	if parsed["name"] == "" {
		parsed["name"] = "default"
	}
	if parsed["version"] == "" {
		parsed["version"] = "1.0.0"
	}
	return parsed, nil
}`;
    case 'Rust':
      return `

Example output for a typical task:

use std::fs;
use std::path::Path;

pub fn load_config(dir: &Path) -> std::io::Result<String> {
    let file_path = dir.join("config.json");
    fs::read_to_string(file_path)
}`;
    default:
      return `\n\nMatch the syntax, file layout, and idioms of the target file.`;
  }
}
