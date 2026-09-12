import { describe, expect, it, vi } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { PrepareExecutionInput } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import { RETIRED_WORKFLOW_MODE_NOTICE } from '../../../core/schemas/enums.js';
import { resumeSavedSession } from './resume.js';
import { readSeatIdentities, writeSeatIdentities } from '../../../core/state/seats.js';

describe('resume mode reconciliation', () => {
  it('resolves --mode instant to quick and emits the retirement notice', async () => {
    const state = {
      ...createInitialState('retired mode feature'),
      phase: 'planning' as const,
      mode: 'standard' as const,
    };
    const prepareExecution = vi.fn(
      async (_input: PrepareExecutionInput) => ({ kind: 'aborted' }) as const,
    );
    const warnings: string[] = [];
    const stderr: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      });

    try {
      await withTempDir('resume-retired-mode', async (projectDir) => {
        await expect(
          resumeSavedSession({
            projectDir,
            sessionId: 'session-1',
            state,
            opts: { mode: 'instant' as never },
            deps: {
              prepareExecution,
              initStores: async () => {},
              renderApp: async () => {},
              runHeadless: async () => {},
              setupWorkflow: async () => ({
                projectDir,
                useFullscreen: false,
                useMouse: false,
                useHover: false,
              }),
            },
          }),
        ).rejects.toThrow(/cancelled/);
      });
    } finally {
      warnSpy.mockRestore();
      writeSpy.mockRestore();
    }

    expect(prepareExecution.mock.calls[0]?.[0]).toMatchObject({ resumeState: { mode: 'quick' } });
    expect(warnings.join('\n')).toContain('resolves to quick');
    expect(stderr.join('')).toContain(RETIRED_WORKFLOW_MODE_NOTICE);
  });
});

describe('resume seat-change notice', () => {
  it('names the seat that changed under the run and leaves the record to the run itself', async () => {
    const state = {
      ...createInitialState('seat change feature'),
      phase: 'planning' as const,
    };
    const prepareExecution = vi.fn(
      async (_input: PrepareExecutionInput) => ({ kind: 'aborted' }) as const,
    );
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });

    try {
      await withTempDir('resume-seat-change', async (projectDir) => {
        const ref = { projectDir, sessionId: 'session-seat-change' };
        writeSeatIdentities(ref, {
          plan: 'Retired Tool · retired-model',
          build: 'Retired Tool · retired-model',
          review: 'Retired Tool · retired-model',
        });

        await expect(
          resumeSavedSession({
            projectDir,
            sessionId: ref.sessionId,
            state,
            opts: {},
            deps: {
              prepareExecution,
              initStores: async () => {},
              renderApp: async () => {},
              runHeadless: async () => {},
              setupWorkflow: async () => ({
                projectDir,
                useFullscreen: false,
                useMouse: false,
                useHover: false,
              }),
            },
          }),
        ).rejects.toThrow(/cancelled/);

        expect(warnings.join('\n')).toContain('PLAN seat changed Retired Tool · retired-model →');
        expect(warnings.join('\n')).toContain('context will be rebuilt');
        expect(readSeatIdentities(ref)?.plan).toBe('Retired Tool · retired-model');
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
