import { describe, it, expect } from 'vitest';
import { gateChangedFiles } from './gate-files.js';
import type { GateChangedFilesInput } from './gate-files.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';

function makeInput(overrides: Partial<GateChangedFilesInput> = {}): GateChangedFilesInput {
  const { bus } = makeBusRecorder();
  const task = makeTask();
  return {
    changedFiles: ['src/foo.ts'],
    task,
    dependsOnFiles: [],
    projectDir: createTempDir('diptych-test'),
    sessionId: 'sess-001',
    phase: 'implementing',
    taskId: task.id,
    bus,
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onComplete: () => {},
    },
    config: makeConfig(),
    ...overrides,
  };
}

describe('gateChangedFiles', () => {
  it('returns allow=true when approval is disabled', async () => {
    const input = makeInput({ config: makeConfig({ approval: { enabled: false } } as Parameters<typeof makeConfig>[0]) });
    const result = await gateChangedFiles(input);
    expect(result.allow).toBe(true);
    expect(result.changedFiles).toEqual(['src/foo.ts']);
  });
});
