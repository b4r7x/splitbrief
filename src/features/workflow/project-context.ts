import type { ProjectContext } from '../../core/state/types.js';
import { readPackageJson } from '../../core/project-meta.js';

export function buildProjectContext(projectDir: string, testCommand: string): ProjectContext {
  const pkg = readPackageJson(projectDir);
  return {
    name: typeof pkg?.['name'] === 'string' ? pkg['name'] : 'unknown',
    dir: projectDir,
    runtime: 'node',
    testCommand,
  };
}
