import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG_FILENAME = 'diptych-keys.log';

let enabled: boolean | undefined;

export function isKeyDebugEnabled(): boolean {
  if (enabled === undefined) {
    const flag = process.env['DIPTYCH_DEBUG_KEYS'];
    enabled = flag !== undefined && flag !== '' && flag !== '0' && flag !== 'false';
  }
  return enabled;
}

export function keyLogPath(): string {
  return join(tmpdir(), LOG_FILENAME);
}

function escapeBytes(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else if (code === 0x5c) {
      out += '\\\\';
    } else {
      out += text[i];
    }
  }
  return out;
}

function append(line: string): void {
  try {
    appendFileSync(keyLogPath(), `${line}\n`, 'utf8');
  } catch {
    // Best-effort diagnostic sink: a debug logger must never disrupt the TUI.
  }
}

export function logRawChunk(chunk: Buffer): void {
  if (!isKeyDebugEnabled()) return;
  const text = chunk.toString('utf8');
  append(`RAW  bytes=${chunk.length} ${escapeBytes(text)}`);
}

export function logParsedKey(input: string, key: Record<string, unknown>): void {
  if (!isKeyDebugEnabled()) return;
  const active = Object.keys(key).filter((name) => key[name] === true);
  append(`KEY  input=${JSON.stringify(escapeBytes(input))} flags=[${active.join(',')}]`);
}
