import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPLITBRIEF_DIR } from '../../src/core/paths.js';

export function writeEmptyDetectionCache(projectDir: string): void {
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(
    join(projectDir, SPLITBRIEF_DIR, 'detection-cache.json'),
    JSON.stringify({
      version: 1,
      timestamp: Date.now(),
      planners: [],
      providers: [],
    }),
    'utf-8',
  );
}
