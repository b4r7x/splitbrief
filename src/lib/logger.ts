import { resolve } from 'node:path';
import { redactSecrets } from '../utils/redact.js';
import { confinedAppendFileSync } from './confined-fs.js';
import { rejectSymlinkTarget } from './fs.js';

export interface Logger {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let projectDir: string | undefined;
let relativePath: string | undefined;
let enabled = false;

export function configureLogger(options: {
  projectDir: string;
  relativePath: string;
  enabled: boolean;
}): void {
  projectDir = options.projectDir;
  relativePath = options.relativePath;
  enabled = options.enabled;
}

export function resetLoggerForTests(): void {
  projectDir = undefined;
  relativePath = undefined;
  enabled = false;
}

function serializeData(data: unknown): string {
  try {
    const json: string | undefined = JSON.stringify(data);
    return json ?? String(data);
  } catch {
    return String(data);
  }
}

function write(level: LogLevel, scope: string, message: string, data: unknown): void {
  if (!enabled || projectDir === undefined || relativePath === undefined) return;
  const suffix = data === undefined ? '' : ` ${serializeData(data)}`;
  const entry = redactSecrets(
    `${new Date().toISOString()} ${level.toUpperCase()} ${process.pid} [${scope}] ${message}${suffix}`,
  ).replaceAll('\n', '\\n');
  try {
    // Re-checked on every append, like the session-log appender: the target can
    // be swapped for a symlink between writes, and a symlinked parent must not
    // redirect the append outside the project.
    rejectSymlinkTarget(resolve(projectDir, relativePath));
    confinedAppendFileSync(projectDir, relativePath, `${entry}\n`);
  } catch {
    // Best-effort diagnostic sink: the logger must never disrupt the app.
  }
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, data) => write('debug', scope, message, data),
    info: (message, data) => write('info', scope, message, data),
    warn: (message, data) => write('warn', scope, message, data),
    error: (message, data) => write('error', scope, message, data),
  };
}
