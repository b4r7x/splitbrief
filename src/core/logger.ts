import { join } from 'node:path';
import { configureLogger } from '../lib/logger.js';
import { SPLITBRIEF_DIR } from './paths.js';

const DEBUG_ENV = 'SPLITBRIEF_DEBUG';

// A development run executes TypeScript sources via tsx, so this module's
// filename ends in `.ts`; a built app runs the compiled `.js` from dist/.
export function resolveLoggerEnabled(input: {
  moduleFilename: string;
  override: string | undefined;
}): boolean {
  const { moduleFilename, override } = input;
  if (override !== undefined && override !== '') {
    return override !== '0' && override !== 'false';
  }
  return moduleFilename.endsWith('.ts');
}

export function initLogger(projectDir: string): void {
  configureLogger({
    projectDir,
    relativePath: join(SPLITBRIEF_DIR, 'logs', 'debug.log'),
    enabled: resolveLoggerEnabled({
      moduleFilename: import.meta.filename,
      override: process.env[DEBUG_ENV],
    }),
  });
}
