import { existsSync, unlinkSync } from 'node:fs';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliDetectionFor } from '#testing/helpers/factories/detection.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { addWorkflowOptions } from '../../options.js';
import { configPath } from '../../../core/config/load/document.js';
import { loadConfig } from '../../../core/config/load/io.js';
import { resolveEffectiveConfig } from '../../../core/config/runtime/effective-config.js';
import { workflowOptsToCLIOverrides } from '../../../core/config/runtime/overrides/from-options.js';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import { readActiveRunner } from '../../../core/config/accessors/active-runner.js';
import type { ActiveRunnerRole } from '../../../core/runners/seat-roles.js';
import type { WorkflowOpts } from '../../../core/types/config-options.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  checkCrewAvailability,
  selectDetectedDefaultCrew,
} from '../../../engine/detection/crew.js';
import { configStore } from '../../../stores/project/config.js';
import { installDiagnosticSink } from '../../../lib/warn.js';
import { runHeadlessStart } from './streaming.js';
import type { StartDeps } from './types.js';

const boundary = vi.hoisted(() => ({ detectAll: vi.fn() }));
vi.mock('../../../engine/detection/detect.js', async (original) => ({
  ...(await original<typeof import('../../../engine/detection/detect.js')>()),
  detectAll: boundary.detectAll,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  configStore.reset();
});

const roles = ['planner', 'implementer', 'reviewer'] as const;
const fieldValues = [
  ['', 'codex'],
  ['-model', 'custom-coder'],
  ['-command', 'node'],
  ['-api-base', 'http://127.0.0.1:12434/v1'],
  ['-api-key-env', 'SEAT_TEST_KEY'],
  ['-args', 'seat-argument'],
  ['-output-format', 'text'],
  ['-context-length', '8192'],
] as const;

function parse(flags: string[]): WorkflowOpts {
  const command = addWorkflowOptions(new Command());
  command.exitOverride().parse(['node', 'start', ...flags]);
  return command.opts<WorkflowOpts>();
}

function fieldsFor(role: ActiveRunnerRole) {
  return role === 'implementer' ? fieldValues : [...fieldValues, ['-effort', 'high'] as const];
}

describe('first-run seat override parity', () => {
  it.each([false, true])(
    'matches Setup and headless without a detected crew, separate reviewer=%s',
    async (separateReviewer) => {
      await withTempDir('explicit-first-run-crew', async (projectDir) => {
        createTestGitRepo(projectDir);
        const detection = {
          cliTools: [cliDetectionFor('unavailable', 'claude-code')],
          providers: [{ provider: 'ollama' as const, available: false, isLocal: true }],
        };
        boundary.detectAll.mockResolvedValue(detection);
        const opts = parse([
          '--planner-command',
          process.execPath,
          '--implementer-command',
          process.execPath,
          '--implementer-model',
          'fixture',
          ...(separateReviewer ? ['--reviewer-command', process.execPath] : []),
        ]);
        expect(selectDetectedDefaultCrew(detection)).toBeNull();
        configStore.load(projectDir, workflowOptsToCLIOverrides(opts));
        const { config: setupConfig, diskConfig: setupPersisted } = configStore.get();
        let preparedConfig: Config | undefined;
        const deps: StartDeps = {
          initStores: async () => {},
          renderApp: async () => {},
          runHeadless: async () => {},
          prepareExecution: async (input) => {
            preparedConfig = input.effectiveConfig;
            return { kind: 'failed', error: new Error('Reached preparation') };
          },
        };
        const notice = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await expect(
            runHeadlessStart({
              deps,
              projectDir,
              feature: 'Explicit crew',
              enrichedFeature: undefined,
              plannerContext: undefined,
              opts,
              mode: 'plain',
            }),
          ).rejects.toThrow('Reached preparation');
          const saved = loadConfig(projectDir).config;
          expect(saved).toEqual(preparedConfig);
          expect(preparedConfig).toEqual(setupConfig);
          expect(saved).toEqual(setupPersisted);
          expect(saved.planner).toMatchObject({ kind: 'shell', command: process.execPath });
          expect(saved.implementer).toMatchObject({ kind: 'shell', command: process.execPath });
          if (separateReviewer)
            expect(saved.reviewer).toMatchObject({ kind: 'shell', command: process.execPath });
          else expect(saved.reviewer).toBeUndefined();
          expect(notice.mock.calls).toEqual([
            ['No config found. Saved a ready crew to .splitbrief/config.yaml.'],
            ['Added .splitbrief/ to .gitignore.'],
          ]);
        } finally {
          notice.mockRestore();
        }
      });
    },
  );

  it('covers every start seat flag and both implementer aliases', () => {
    const flags = addWorkflowOptions(new Command()).options.map((option) => option.long);
    const seatFlags = flags.filter((flag) => roles.some((role) => flag?.startsWith(`--${role}`)));
    expect(seatFlags.sort()).toEqual(
      roles.flatMap((role) => fieldsFor(role).map(([suffix]) => `--${role}${suffix}`)).sort(),
    );
    expect(flags).toContain('--provider');
    expect(flags).toContain('--model');
  });

  it.each(roles.flatMap((role) => [true, false].map((claudeReady) => ({ role, claudeReady }))))(
    'matches Setup and headless for every $role field subset, Claude ready=$claudeReady',
    async ({ role, claudeReady }) => {
      await withTempDir('seat-override-parity', async (projectDir) => {
        createTestGitRepo(projectDir);
        vi.stubEnv('SEAT_TEST_KEY', 'test-key');
        vi.stubGlobal(
          'fetch',
          vi.fn(async (input: string | URL | Request) => {
            if (
              !String(input instanceof Request ? input.url : input).startsWith(
                'http://127.0.0.1:12434/',
              )
            )
              throw new Error('Offline default');
            return Response.json({ models: [{ name: 'custom-coder' }] });
          }),
        );
        const detection = {
          cliTools: [
            cliDetectionFor(claudeReady ? 'ready' : 'unavailable', 'claude-code'),
            cliDetectionFor('ready', 'codex'),
          ],
          providers: [{ provider: 'ollama' as const, available: false, isLocal: true }],
        };
        boundary.detectAll.mockResolvedValue(detection);
        const persisted = selectDetectedDefaultCrew(detection);
        if (persisted === null) throw new Error('Expected a ready default crew');
        const fields = fieldsFor(role);
        const restoreDiagnostics = installDiagnosticSink(() => {});
        const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          for (let mask = 0; mask < 2 ** fields.length; mask += 1) {
            if (existsSync(configPath(projectDir))) unlinkSync(configPath(projectDir));
            const flags = fields.flatMap(([suffix, value], bit) =>
              mask & (1 << bit) ? [`--${role}${suffix}`, value] : [],
            );
            const opts = parse(flags);
            const overrides = workflowOptsToCLIOverrides(opts);
            let setupConfig: Config | undefined;
            let setupError: unknown;
            try {
              configStore.load(projectDir, overrides);
              configStore.setInitialCrew(persisted);
              setupConfig = configStore.get().config ?? undefined;
            } catch (cause) {
              setupError = cause;
            }
            let headlessConfig: Config | undefined;
            const deps: StartDeps = {
              initStores: async () => {},
              renderApp: async () => {},
              runHeadless: async () => {},
              prepareExecution: async (input) => {
                headlessConfig = input.effectiveConfig;
                return { kind: 'failed', error: new Error('Reached preparation') };
              },
            };
            let headlessError: unknown;
            try {
              await runHeadlessStart({
                deps,
                projectDir,
                feature: 'Seat parity',
                enrichedFeature: undefined,
                plannerContext: undefined,
                opts,
                mode: 'plain',
              });
            } catch (cause) {
              headlessError = cause;
            }
            const label = flags.join(' ') || 'no overrides';
            if (setupError instanceof Error) {
              expect(headlessError, label).toBeInstanceOf(Error);
              expect(headlessError instanceof Error ? headlessError.message : '', label).toBe(
                setupError.message,
              );
              continue;
            }
            if (setupConfig === undefined) throw new Error('Setup did not select a crew');
            const unavailable = await checkCrewAvailability({ config: setupConfig, detection });
            if (unavailable.length === 0) expect(headlessConfig, label).toEqual(setupConfig);
            else {
              expect(headlessConfig, label).toBeUndefined();
              expect(headlessError instanceof Error ? headlessError.message : '', label).toContain(
                `${unavailable[0]?.label} is unavailable`,
              );
              expect(existsSync(configPath(projectDir)), label).toBe(false);
            }
            if (mask !== 0) {
              const intended = resolveEffectiveConfig({
                base: createDefaultConfig(),
                overrides,
              }).config;
              expect(readActiveRunner({ config: setupConfig, role }), label).toEqual(
                readActiveRunner({ config: intended, role }),
              );
            }
          }
        } finally {
          silence.mockRestore();
          restoreDiagnostics();
        }
      });
    },
    120_000,
  );

  it.each([
    ['--provider', 'codex'],
    ['--model', 'custom-coder'],
    ['--provider', 'codex', '--model', 'custom-coder'],
    ['--provider', 'codex', '--implementer', 'claude-code'],
    ['--implementer', 'claude-code', '--provider', 'codex'],
    ['--model', 'alias-model', '--implementer-model', 'seat-model'],
    ['--implementer-model', 'seat-model', '--model', 'alias-model'],
  ])('preserves implementer alias precedence: %s', (...flags) => {
    const overrides = workflowOptsToCLIOverrides(parse(flags));
    expect(overrides.implementer?.tool).toBe(
      flags.includes('--implementer')
        ? 'claude-code'
        : flags.includes('--provider')
          ? 'codex'
          : undefined,
    );
    expect(overrides.implementer?.model).toBe(
      flags.includes('--implementer-model')
        ? 'seat-model'
        : flags.includes('--model')
          ? 'custom-coder'
          : undefined,
    );
  });
});
