import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { PrepareExecutionInput } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import type { ReadinessReport } from '../../../core/readiness/types.js';
import { resumeSavedSession } from './resume.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { saveDetectionCache } from '../../../engine/detection/cache.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import {
  readSeatIdentities,
  seatIdentitiesFromConfig,
  writeSeatIdentities,
} from '../../../core/state/seats.js';

// A resume without --json or --plain mounts the TUI, which needs a terminal.
beforeEach(() => {
  process.stdin.isTTY = true;
});

afterEach(() => {
  modelCacheStore.reset();
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe('resume seat-change notice', () => {
  it('loads remembered catalog names before reporting a changed seat headlessly', async () => {
    await withTempDir('resume-catalog-label', async (projectDir) => {
      const runner = { kind: 'cli', tool: 'codex', model: 'gpt-6-luna' } as const;
      const config = makeConfig({ implementer: runner });
      writeConfig(projectDir, config);
      const ref = { projectDir, sessionId: 'catalog-label' };
      writeSeatIdentities(
        ref,
        seatIdentitiesFromConfig(
          makeConfig({
            implementer: { ...runner, model: 'gpt-5' },
          }),
        ),
      );
      await saveDetectionCache({
        projectDir,
        snapshot: {
          contextKey: 'remembered',
          fetchedAt: 1,
          validatedAt: 1,
          generation: 1,
          requestId: 1,
          providers: [],
          cliTools: [],
          cliCatalogs: [
            {
              tool: 'codex',
              models: [{ id: runner.model, displayName: 'GPT-6-Luna' }],
              probedAt: 1,
            },
          ],
        },
      });
      const warnings: string[] = [];
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation((message) => warnings.push(String(message)));
      try {
        await expect(
          resumeSavedSession({
            ...ref,
            config,
            state: createInitialState('catalog label'),
            opts: { plain: true },
            deps: {
              prepareExecution: async () => ({ kind: 'aborted' }),
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
        expect(warnings.join('\n')).toContain('→ OpenAI Codex CLI · GPT-6-Luna;');
        expect(warnings.join('\n')).not.toContain('GPT-6 Luna');
      } finally {
        warn.mockRestore();
      }
    });
  });

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

  it('names the seat it moved from in the words the seat identity uses', async () => {
    const state = { ...createInitialState('seat label feature'), phase: 'planning' as const };
    const prepareExecution = vi.fn(
      async (_input: PrepareExecutionInput) => ({ kind: 'aborted' }) as const,
    );
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '));
    });

    try {
      await withTempDir('resume-seat-labels', async (projectDir) => {
        const ref = { projectDir, sessionId: 'session-seat-labels' };
        writeSeatIdentities(
          ref,
          seatIdentitiesFromConfig(
            makeConfig({
              planner: { kind: 'cli', tool: 'claude-code', model: 'opus', effort: 'max' },
            }),
          ),
        );

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

        expect(warnings.join('\n')).toContain(
          'PLAN seat changed Claude Code CLI · Opus 5.5 · max →',
        );
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('headless resume on a blocked run', () => {
  const remediation =
    'Use a system-installed command, or continue the run from the command line with `splitbrief continue --allow-repo-runners`.';

  function blockedReport(projectDir: string): ReadinessReport {
    return {
      generatedAt: new Date().toISOString(),
      projectDir,
      status: 'blocked',
      counts: { ok: 0, info: 0, warning: 0, blocker: 1 },
      nextAction: { kind: 'fix-config', label: 'Fix config', reason: 'BUILD could not start.' },
      sections: [
        {
          id: 'runners',
          title: 'Runners',
          checks: [
            {
              id: 'runners.preparation.implementer.default',
              severity: 'blocker',
              summary: 'BUILD could not start.',
              fix: remediation,
            },
          ],
        },
      ],
      metadata: {},
    };
  }

  it.each([{ plain: true }, { json: true }])(
    'prints the blocker and its fix on stderr before the error (%o)',
    async (opts) => {
      await withTempDir('resume-blocked', async (projectDir) => {
        writeConfig(projectDir, makeConfig());
        const out: string[] = [];
        const err: string[] = [];
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
          out.push(String(chunk));
          return true;
        });
        const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
          err.push(String(chunk));
          return true;
        });
        const runHeadless = vi.fn(async () => {});
        try {
          await expect(
            resumeSavedSession({
              projectDir,
              sessionId: 'blocked-resume',
              state: createInitialState('blocked resume'),
              opts,
              deps: {
                prepareExecution: async () => ({
                  kind: 'blocked',
                  report: blockedReport(projectDir),
                }),
                initStores: async () => {},
                renderApp: async () => {},
                runHeadless,
                setupWorkflow: async () => ({
                  projectDir,
                  useFullscreen: false,
                  useMouse: false,
                  useHover: false,
                }),
              },
            }),
          ).rejects.toThrow(/Resolve the blocker above/);
        } finally {
          stdout.mockRestore();
          stderr.mockRestore();
        }
        const errText = err.join('');
        expect(errText).toContain('Run readiness: blocked (1 blocker)');
        expect(errText).toContain('BUILD could not start.');
        expect(errText).toContain('`splitbrief continue --allow-repo-runners`');
        expect(errText.split('Run readiness: blocked').length).toBe(2);
        expect(out.join('')).toBe('');
        expect(runHeadless).not.toHaveBeenCalled();
      });
    },
  );
});
