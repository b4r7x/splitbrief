/** Claude Code exposes no model-listing command, so we read its undocumented, per-account,
 * delta-only `~/.claude.json` option cache best-effort — any absence or drift yields no options. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClaudeCodeModelOption {
  readonly id: string;
  readonly displayName?: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function loadClaudeCodeModelOptions(homeDir: string): readonly ClaudeCodeModelOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(homeDir, '.claude.json'), 'utf8'));
  } catch {
    return [];
  }

  if (!isRecord(parsed)) return [];

  const cache = parsed.additionalModelOptionsCache;
  const entries = Array.isArray(cache) ? cache : isRecord(cache) ? Object.values(cache) : undefined;
  if (!entries) return [];

  const options: ClaudeCodeModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = nonEmptyString(entry.value);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const label = nonEmptyString(entry.label);
    options.push({ id, ...(label === undefined ? {} : { displayName: label }) });
  }
  return options;
}

let cached: readonly ClaudeCodeModelOption[] | undefined;

export function readClaudeCodeModelOptions(): readonly ClaudeCodeModelOption[] {
  cached ??= loadClaudeCodeModelOptions(homedir());
  return cached;
}
