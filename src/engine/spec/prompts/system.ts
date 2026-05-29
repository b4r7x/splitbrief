import { buildLanguageContext, type LanguageContext } from './language-context.js';

export function buildSystemPreamble(languageContext?: LanguageContext): string {
  const ctx = languageContext ?? buildLanguageContext(undefined);
  const example = exampleOutput(ctx);
  const intro =
    ctx.language === 'the project language'
      ? 'SYSTEM: You are a code generator for the project language. You write clean, working code that matches the target file.'
      : `SYSTEM: You are a ${ctx.language} code generator. You write clean, working ${ctx.language} code.`;

  return `${intro}
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
