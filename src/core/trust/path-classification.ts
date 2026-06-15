import { resolve } from 'node:path';
import { isInsideRoot } from '../../lib/path-confinement.js';

const CODE_LOADING_INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'npx',
  'tsx',
  'ts-node',
  'bun',
  'deno',
]);

export function isPathLike(token: string): boolean {
  if (token.includes('/') || token.includes('\\')) return true;
  return /^[a-zA-Z0-9_.-]+[\\/][a-zA-Z0-9_.\\/-]+$/.test(token);
}

export function isRepoLocal(token: string, projectDir: string): boolean {
  if (token.startsWith('./') || token.startsWith('../')) return true;
  if (token.startsWith('/')) {
    return isInsideRoot(resolve(projectDir), resolve(token));
  }
  if (isPathLike(token)) return true;
  return false;
}

export function commandTokensAfterInterpreter(tokens: readonly string[]): readonly string[] {
  const interpreter = tokens[0] ?? '';
  return CODE_LOADING_INTERPRETERS.has(interpreter) && tokens.length > 1 ? tokens.slice(1) : tokens;
}
