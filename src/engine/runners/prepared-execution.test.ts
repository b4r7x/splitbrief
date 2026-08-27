import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDefaultConfig } from '../../core/config/load/io.js';
import { resolveRunnerConfigContext } from '../../core/config/accessors/runner-config.js';
import { sessionDir } from '../../core/paths.js';
import type { Config } from '../../core/schemas/config.js';
import { readActive } from '../../core/sessions/active-pointer.js';
import {
  createSessionPreparationCandidate,
  prepareNewSession,
} from '../../core/sessions/prepare.js';
import {
  parsePreparedConfig,
  releasePreparedExecutionOwnership,
  rollbackPreparedExecutionOwnership,
  type PreparedExecution,
} from './prepared-execution.js';

const OWNERSHIP_FILE = '.prepare-owner.json';
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) cleanupTempDir(directory);
});

function executionWithSession(session: PreparedExecution['session']): PreparedExecution {
  const projectDir = session.ref.projectDir;
  return {
    purpose: 'new-workflow',
    config: parsePreparedConfig(createDefaultConfig()),
    preparationId: 'prepared-execution-test',
    report: {
      generatedAt: '2026-08-04T00:00:00.000Z',
      projectDir,
      status: 'ready',
      counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
      nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
      sections: [],
      metadata: {},
    },
    gates: [],
    session,
    runtime: {
      feature: 'ownership helper test',
      allowRepoRunners: false,
      allowHooks: false,
    },
  };
}

function prepareNewExecution(sessionId: string): PreparedExecution {
  const projectDir = createTempDir('prepared-execution-ownership');
  tempDirs.push(projectDir);
  const config = parsePreparedConfig(createDefaultConfig());
  const report = {
    generatedAt: '2026-08-04T00:00:00.000Z',
    projectDir,
    status: 'ready' as const,
    counts: { ok: 1, info: 0, warning: 0, blocker: 0 },
    nextAction: { kind: 'continue' as const, label: 'Continue', reason: 'Ready' },
    sections: [],
    metadata: {},
  };
  const prepared = prepareNewSession({
    projectDir,
    feature: 'ownership helper test',
    config,
    report,
    signal: new AbortController().signal,
    candidate: createSessionPreparationCandidate({
      projectDir,
      feature: 'ownership helper test',
      persistTranscript: true,
      sessionId,
    }),
  });
  if (prepared.kind !== 'prepared') throw new Error('Session preparation was aborted');
  return executionWithSession({ kind: 'new', ...prepared.session });
}

describe('prepared execution', () => {
  it('keeps ownership only on new sessions and active receipts on both variants', () => {
    const newExecution = prepareNewExecution('prepared-session');
    const { ref, active } = newExecution.session;
    const existingExecution = executionWithSession({ kind: 'existing', ref, active });
    const marker = join(sessionDir(ref.projectDir, ref.sessionId), OWNERSHIP_FILE);

    expect(newExecution.session).toHaveProperty('ownership');
    expect(existsSync(marker)).toBe(true);
    expect(existingExecution.session).not.toHaveProperty('ownership');
    expect(existingExecution.session.active).toEqual(active);

    releasePreparedExecutionOwnership(existingExecution);

    expect(existsSync(marker)).toBe(true);
  });

  it('deep freezes the parsed config snapshot without serializing secrets', () => {
    const secret = 'sk-private-inline-value';
    const input = {
      ...createDefaultConfig(),
      planner: {
        kind: 'api',
        provider: 'anthropic',
        service: 'anthropic',
        offering: 'payg',
        apiBase: 'https://api.anthropic.com/v1',
        apiKey: secret,
        model: 'claude-opus-4-6',
      },
    };
    const serialize = vi.spyOn(JSON, 'stringify');

    const prepared: Config = parsePreparedConfig(input);
    const readonlyConfig: PreparedExecution['config'] = prepared;
    const serialized = serialize.mock.results.flatMap((result) =>
      result.type === 'return' && typeof result.value === 'string' ? [result.value] : [],
    );
    input.planner.apiKey = 'changed-after-preparation';
    serialize.mockRestore();

    expect(serialized.every((value) => !value.includes(secret))).toBe(true);
    expect(readonlyConfig).toBe(prepared);
    expect(prepared.planner).toMatchObject({ kind: 'api', apiKey: secret });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.planner)).toBe(true);
    expect(Object.isFrozen(prepared.workflow)).toBe(true);
    expect(Reflect.set(prepared.workflow, 'maxRetries', 99)).toBe(false);
  });

  it('provides frozen planner profile and intermediate runners to the shared resolver', () => {
    const config = parsePreparedConfig({
      ...createDefaultConfig(),
      implementerProfiles: {
        default: 'fast',
        profiles: {
          fast: {
            kind: 'cli',
            tool: 'codex',
            args: ['--profile', 'fast'],
          },
        },
      },
    });
    const fast = config.implementerProfiles?.profiles.fast;
    if (fast === undefined) throw new Error('Prepared profile fixture is missing');

    expect(resolveRunnerConfigContext({ role: 'planner', runner: config.planner })).toEqual({
      slot: { role: 'planner' },
      runner: config.planner,
    });
    expect(
      resolveRunnerConfigContext({ role: 'implementer', profile: 'fast', runner: fast }),
    ).toEqual({
      slot: { role: 'implementer', profile: 'fast' },
      runner: fast,
    });
    expect(
      resolveRunnerConfigContext({ role: 'intermediate', runner: config.implementer }),
    ).toEqual({
      slot: { role: 'intermediate' },
      runner: config.implementer,
    });
  });

  it('does not mutate ownership for an existing session', () => {
    const prepared = prepareNewExecution('existing-session');
    const execution = executionWithSession({
      kind: 'existing',
      ref: prepared.session.ref,
      active: prepared.session.active,
    });
    const directory = sessionDir(execution.session.ref.projectDir, execution.session.ref.sessionId);
    const marker = join(directory, OWNERSHIP_FILE);

    releasePreparedExecutionOwnership(execution);
    rollbackPreparedExecutionOwnership(execution);

    expect(existsSync(marker)).toBe(true);
    expect(existsSync(directory)).toBe(true);
    expect(readActive(execution.session.ref.projectDir)).toBe(execution.session.ref.sessionId);
  });

  it('releases new-session ownership while retaining the active session', () => {
    const execution = prepareNewExecution('released-session');
    const directory = sessionDir(execution.session.ref.projectDir, execution.session.ref.sessionId);
    const marker = join(directory, OWNERSHIP_FILE);
    expect(existsSync(marker)).toBe(true);

    releasePreparedExecutionOwnership(execution);

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(directory)).toBe(true);
    expect(readActive(execution.session.ref.projectDir)).toBe(execution.session.ref.sessionId);
  });

  it('rolls back the owned new-session directory and active receipt', () => {
    const execution = prepareNewExecution('rolled-back-session');
    const directory = sessionDir(execution.session.ref.projectDir, execution.session.ref.sessionId);
    expect(existsSync(directory)).toBe(true);
    expect(readActive(execution.session.ref.projectDir)).toBe(execution.session.ref.sessionId);

    rollbackPreparedExecutionOwnership(execution);

    expect(existsSync(directory)).toBe(false);
    expect(readActive(execution.session.ref.projectDir)).toBeNull();
  });
});
