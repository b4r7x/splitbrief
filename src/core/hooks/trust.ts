import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecureFile } from '../../lib/fs.js';

const TRUST_FILE = 'hook-trust.json';
const TRUST_VERSION = 1;

interface TrustFile { version: number; trusted_hash: string; }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function hashHooksConfig(hooks: unknown): string {
  const json = canonicalJson(hooks ?? null);
  const hex = createHash('sha256').update(json, 'utf8').digest('hex');
  return `sha256:${hex}`;
}

function trustFilePath(projectDir: string): string {
  return join(projectDir, '.diptych', TRUST_FILE);
}

export function isHooksConfigTrusted(projectDir: string, hooks: unknown): boolean {
  const path = trustFilePath(projectDir);
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as TrustFile;
    if (parsed.version !== TRUST_VERSION) return false;
    return parsed.trusted_hash === hashHooksConfig(hooks);
  } catch {
    return false;
  }
}

export function markHooksConfigTrusted(projectDir: string, hooks: unknown): void {
  const file: TrustFile = { version: TRUST_VERSION, trusted_hash: hashHooksConfig(hooks) };
  writeSecureFile(trustFilePath(projectDir), JSON.stringify(file, null, 2) + '\n');
}
