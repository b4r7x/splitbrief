import { afterAll } from 'vitest';
import './scrub-credentials.js';
import { cleanupTempDir, createdTempDirs, createTempDir } from './temp-dir.js';

// Run isolation resolves its worktrees under the user state directory
// ($XDG_STATE_HOME, else ~/.local/state), so any suite reaching runWorkflow
// writes into the operator's own state directory and leaves this repository's
// directory behind there. Every test file gets a throwaway state home instead,
// set before the file's modules load and removed when the file ends; a file
// that needs its own still overrides the variable itself.
const stateHome = createTempDir('splitbrief-test-state');
process.env.XDG_STATE_HOME = stateHome;

afterAll(async () => {
  cleanupTempDir(stateHome);
  // Imported only now: a static import here would load the module graph before
  // a test file's `vi.mock` of `node:fs` applies.
  const { removeSandboxTempDirs } = await import('../../src/engine/runners/sandbox-state-paths.js');
  for (const dir of createdTempDirs) removeSandboxTempDirs(dir);
});
