import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureLogger } from '../../src/lib/logger.js';

const DEBUG_LOG = 'debug.log';

export function enableDebugLog(projectDir: string): void {
  configureLogger({ projectDir, relativePath: DEBUG_LOG, enabled: true });
}

/** The data of every `DEBUG [scope] code` line the log of `projectDir` holds, in order. */
export function debugLogEntries(projectDir: string, scope: string, code: string): unknown[] {
  const path = join(projectDir, DEBUG_LOG);
  if (!existsSync(path)) return [];
  const marker = ` DEBUG ${process.pid} [${scope}] ${code} `;
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const at = line.indexOf(marker);
      return at === -1 ? [] : [JSON.parse(line.slice(at + marker.length))];
    });
}
