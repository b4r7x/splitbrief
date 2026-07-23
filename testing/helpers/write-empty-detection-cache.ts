import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIPTYCH_DIR } from '../../src/core/paths.js';

export function writeEmptyDetectionCache(projectDir: string): void {
  mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
  writeFileSync(
    join(projectDir, DIPTYCH_DIR, 'detection-cache.json'),
    JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      planners: [],
      implementers: [],
    }),
    'utf-8',
  );
}
