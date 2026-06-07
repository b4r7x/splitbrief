import { join } from 'node:path';
import {
  configureKeyDebugLog,
  isKeyDebugEnabled,
  logParsedKey,
  logRawChunk,
} from '../lib/terminal/debug-keys.js';
import { DIPTYCH_DIR } from './paths.js';

const DEBUG_KEYS_ENV = 'DIPTYCH_DEBUG_KEYS';

function envFlagEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

export function isDiptychKeyDebugEnabled(): boolean {
  return envFlagEnabled(process.env[DEBUG_KEYS_ENV]);
}

export function configureDiptychKeyDebugLog(options?: { projectDir?: string | undefined }): void {
  configureKeyDebugLog({
    enabled: isDiptychKeyDebugEnabled(),
    target: options?.projectDir
      ? {
          kind: 'project',
          projectDir: options.projectDir,
          relativeDir: join(DIPTYCH_DIR, 'debug'),
          filePrefix: 'keys',
        }
      : { kind: 'temp', filePrefix: 'diptych-keys' },
  });
}

export function isConfiguredKeyDebugEnabled(): boolean {
  return isKeyDebugEnabled();
}

export function logDiptychRawKeyChunk(chunk: Buffer): void {
  logRawChunk(chunk);
}

export function logDiptychParsedKey(input: string, key: Record<string, unknown>): void {
  logParsedKey(input, key);
}
