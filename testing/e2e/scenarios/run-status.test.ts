import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_LOG_FILE, sessionDir } from '../../../src/core/paths.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { writeActive } from '../../../src/core/sessions/active-pointer.js';
import { updateHeartbeat, writeLockfile } from '../../../src/core/sessions/lockfile.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { stripTerminalControls } from '../../../src/utils/display-text.js';
import { startHeartbeat } from '../../../src/engine/orchestrator/run/heartbeat.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { cli } from '../helpers/stop-continue-fixture.js';

const CASES: (Partial<WorkflowState> & { word: string; live?: boolean })[] = [
  { phase: 'complete', reviewStatus: 'passed', word: 'ready to apply' },
  { phase: 'implementing', awaitingContinue: true, word: 'stopped' },
  { phase: 'reviewing-plan', word: 'waiting for you' },
  { phase: 'implementing', live: true, word: 'running' },
];

describe('status reads the durable run status', () => {
  it.each(CASES)('prints $word for a saved $phase run', async ({ word, live, ...overrides }) => {
    await withTempDir('run-status-e2e', async (tmpDir) => {
      const projectDir = join(tmpDir, 'project');
      const stateHome = join(tmpDir, 'state');
      const binDir = join(tmpDir, 'bin');
      mkdirSync(projectDir);
      mkdirSync(stateHome);
      mkdirSync(binDir);
      const gitCalls = join(tmpDir, 'git-calls.jsonl');
      writeFakeNodeCli(
        binDir,
        'git',
        `const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(gitCalls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(1);`,
      );
      const restorePath = activateSafeCliShimPath(binDir);
      const ref = { projectDir, sessionId: '2026-10-13-status' };
      const runDir = sessionDir(projectDir, ref.sessionId);
      let stopHeartbeat: (() => void) | undefined;
      try {
        const state: WorkflowState = {
          ...createInitialState('Add a greeting,\nas one task'),
          workspace: {
            kind: 'worktree',
            path: join(tmpDir, 'workspace'),
            base: { snapshotId: 'base', head: null },
          },
          ...overrides,
        };
        saveState(ref, state);
        writeFileSync(join(runDir, SESSION_LOG_FILE), '');
        writeActive(ref);
        if (live) {
          await writeLockfile(runDir, {
            sessionId: ref.sessionId,
            pid: process.pid,
            startTimeMs: 0,
            lastAliveMs: Date.now(),
            feature: state.feature,
          });
          stopHeartbeat = startHeartbeat(runDir);
        }

        const result = await cli({ projectDir, stateHome }, ['status']);

        expect(result.exitCode, result.stderr).toBe(0);
        const output = stripTerminalControls(result.stdout);
        expect(output).toContain(`Status:   ${word}`);
        expect(output).not.toContain('Phase:');
        expect(output).not.toContain('awaiting continue');
        expect(output).toContain('Feature:  Add a greeting, as one task');
        expect(readFileSync(gitCalls, 'utf8')).toContain('rev-parse');
      } finally {
        if (stopHeartbeat !== undefined) {
          stopHeartbeat();
          await updateHeartbeat(runDir);
        }
        restorePath();
      }
    });
  });
});
