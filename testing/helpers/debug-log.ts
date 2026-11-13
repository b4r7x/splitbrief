import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureLogger } from '../../src/lib/logger.js';

const DEBUG_LOG = 'debug.log';

export function enableDebugLog(projectDir: string): void {
  configureLogger({ projectDir, relativePath: DEBUG_LOG, enabled: true });
}

function debugLogLines(projectDir: string): string[] {
  const path = join(projectDir, DEBUG_LOG);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
}

/** The data of every `DEBUG [scope] code` line the log of `projectDir` holds, in order. */
export function debugLogEntries(projectDir: string, scope: string, code: string): unknown[] {
  const marker = ` DEBUG ${process.pid} [${scope}] ${code} `;
  return debugLogLines(projectDir).flatMap((line) => {
    const at = line.indexOf(marker);
    return at === -1 ? [] : [JSON.parse(line.slice(at + marker.length))];
  });
}

/** The text of every diagnostic (`WARN [diagnostics]` line) the log of `projectDir` holds, in order. */
export function loggedDiagnostics(projectDir: string): string[] {
  const marker = ` WARN ${process.pid} [diagnostics] `;
  return debugLogLines(projectDir).flatMap((line) => {
    const at = line.indexOf(marker);
    return at === -1 ? [] : [line.slice(at + marker.length)];
  });
}
