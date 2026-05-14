import type { ProjectContext } from '../../core/state/types.js';

export function buildProjectContext(projectDir: string, testCommand: string): ProjectContext {
  return {
    name: 'unknown',
    dir: projectDir,
    runtime: 'node',
    testCommand,
  };
}
