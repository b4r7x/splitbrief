import { randomBytes } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confinedAppendFileSync, confinedEnsureDir } from '../confined-fs.js';

export type KeyDebugLogTarget =
  | { kind: 'project'; projectDir: string; relativeDir: string; filePrefix: string }
  | { kind: 'temp'; filePrefix: string };

let enabled = false;
let targetConfig: KeyDebugLogTarget | undefined;
let logTarget:
  | { kind: 'project'; projectDir: string; relativePath: string }
  | { kind: 'temp'; absolutePath: string }
  | undefined;

export function configureKeyDebugLog(options: {
  enabled: boolean;
  target?: KeyDebugLogTarget | undefined;
}): void {
  enabled = options.enabled;
  targetConfig = options.target;
  logTarget = undefined;
}

export function isKeyDebugEnabled(): boolean {
  return enabled;
}

export function initKeyDebugLog(target = targetConfig): void {
  if (!isKeyDebugEnabled()) return;
  if (!target) return;
  const suffix = randomBytes(8).toString('hex');
  if (target.kind === 'project') {
    const relativePath = join(target.relativeDir, `${target.filePrefix}-${suffix}.log`);
    confinedEnsureDir(target.projectDir, target.relativeDir);
    logTarget = { kind: 'project', projectDir: target.projectDir, relativePath };
    return;
  }
  logTarget = {
    kind: 'temp',
    absolutePath: join(tmpdir(), `${target.filePrefix}-${suffix}.log`),
  };
}

export function keyLogPath(): string | undefined {
  if (!logTarget) return undefined;
  if (logTarget.kind === 'project') {
    return join(logTarget.projectDir, logTarget.relativePath);
  }
  return logTarget.absolutePath;
}

export function resetKeyDebugForTests(): void {
  enabled = false;
  targetConfig = undefined;
  logTarget = undefined;
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
  if (!logTarget) initKeyDebugLog();
  if (!logTarget) return;

  try {
    if (logTarget.kind === 'project') {
      confinedAppendFileSync(logTarget.projectDir, logTarget.relativePath, `${line}\n`);
      return;
    }

    const path = logTarget.absolutePath;
    try {
      if (lstatSync(path).isSymbolicLink()) return;
    } catch {
      // File doesn't exist yet — ok to create
    }
    mkdirSync(tmpdir(), { recursive: true });
    appendFileSync(path, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
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
