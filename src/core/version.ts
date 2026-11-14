import { join } from 'node:path';
import { readPackageJson } from './project-meta.js';

let cachedVersion: string | null = null;

function readPackageVersion(): string {
  try {
    const root = join(import.meta.dirname, '..', '..');
    const parsed = readPackageJson(root);
    return typeof parsed?.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function getSplitbriefVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  cachedVersion = readPackageVersion();
  return cachedVersion;
}
