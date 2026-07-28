import { join } from 'node:path';
import {
  configureKeyDebugLog,
  isKeyDebugEnabled,
  logParsedKey,
  logRawChunk,
} from '../lib/terminal/key-debug.js';
import { SPLITBRIEF_DIR } from './paths.js';

const DEBUG_KEYS_ENV = 'SPLITBRIEF_DEBUG_KEYS';

function envFlagEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

export function isSplitbriefKeyDebugEnabled(): boolean {
  return envFlagEnabled(process.env[DEBUG_KEYS_ENV]);
}

export function configureSplitbriefKeyDebugLog(options?: {
  projectDir?: string | undefined;
}): void {
  configureKeyDebugLog({
    enabled: isSplitbriefKeyDebugEnabled(),
    target: options?.projectDir
      ? {
          kind: 'project',
          projectDir: options.projectDir,
          relativeDir: join(SPLITBRIEF_DIR, 'debug'),
          filePrefix: 'keys',
        }
      : { kind: 'temp', filePrefix: 'splitbrief-keys' },
  });
}

export function isConfiguredKeyDebugEnabled(): boolean {
  return isKeyDebugEnabled();
}

export function logSplitbriefRawKeyChunk(chunk: Buffer): void {
  logRawChunk(chunk);
}

export function logSplitbriefParsedKey(input: string, key: Record<string, unknown>): void {
  logParsedKey(input, key);
}
