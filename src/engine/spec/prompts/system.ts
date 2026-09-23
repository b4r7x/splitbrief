import type { ImplementerWriteMode } from '../../../core/schemas/implementer-config.js';
import type { BuildOutputContract } from '../../implementers/file-bundle.js';
import { buildLanguageContext, type LanguageContext } from './language-context.js';

export function workspaceRules(dir: string): string {
  return `- Stay inside ${dir}: read, search, write and run shell commands only there, and never look for other copies of the project
- Use git only to read (status, diff, log, show); never commit, branch, tag, checkout, switch, stash, reset, restore, rebase, merge, add, or change git config or hooks
- Dependencies are already installed; never run a package-manager install, ci, add, remove or update (npm, pnpm, yarn, bun)`;
}

export function buildImplementerSystemPreamble(
  languageContext: LanguageContext,
  writesFiles: ImplementerWriteMode,
  isolationDir: string,
  outputContract?: BuildOutputContract | undefined,
): string {
  if (outputContract === 'file-bundle-v1') return buildFileBundlePreamble(languageContext);
  if (writesFiles === 'extracted-code') return buildSystemPreamble(languageContext);

  return `SYSTEM: You are a coding agent for ${languageContext.language}. You write clean, working code directly in the isolation directory. Your changes are promoted into the user's project afterwards.
Rules:
${workspaceRules(isolationDir)}
- Edit ONLY the files the Task Brief lists under Files, plus every path its Scope names under In bounds or Approved out of bounds. Every other file is out of bounds.
- Do NOT add comments unless specified in the task
- Use ${languageContext.importConvention}
- Follow the exact function signatures provided
- Stop and report rather than guessing when the brief's stop conditions are met, when the target file's current content contradicts the brief, or when the change would require touching a file outside scope
- Run the validation commands the brief lists if they are available; SPLITBRIEF runs them again after promotion and its verdict is the authority, so report a failure you cannot fix rather than working around it
- End with a completion report stating which files you wrote and whether the brief's steps were completed; if you changed nothing, say so explicitly

Example completion report:

Files written:
- <file path>

Steps completed: all (or list the brief's steps you could not complete)`;
}

function preambleIntro(ctx: LanguageContext): string {
  return ctx.language === 'the project language'
    ? 'SYSTEM: You are a code generator for the project language. You write clean, working code that matches the target file.'
    : `SYSTEM: You are a ${ctx.language} code generator. You write clean, working ${ctx.language} code.`;
}

/**
 * The `file-bundle-v1` grammar: one JSON object carrying the complete contents
 * of every declared file the answer changes. The brief's own files are the only
 * paths it may name, and the response text never picks the grammar.
 */
function buildFileBundlePreamble(ctx: LanguageContext): string {
  return `${preambleIntro(ctx)}
Rules:
- Answer with ONE JSON object and nothing else: {"version":1,"files":[{"path":"...","action":"create"|"modify","content":"..."}]}
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
