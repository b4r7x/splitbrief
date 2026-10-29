import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import {
  DRIFT_REPORT_FILE,
  REVIEW_FILE,
  SPEC_FILE,
  TASKS_FILE,
  sessionDir,
} from '../../core/paths.js';
import { createEvidenceLedger } from '../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import {
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import type { Config } from '../../core/schemas/config.js';
import { buildApiReviewContext, type ApiReviewContextInput } from './api-review-context.js';
import { runFinalReviewPhase } from './final-review.js';
import { estimateTokens } from '../../core/tokens/estimate.js';

const universe = vi.hoisted(() => ({ fullDiff: '', changedFiles: [] as string[] }));
const drift = vi.hoisted(() => ({ fails: false }));

// The run universe is git's answer; this suite is about what the packet does
// with it, and nothing here may touch a repository.
vi.mock('./evidence/review-packet/sections-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./evidence/review-packet/sections-io.js')>();
  return {
    ...actual,
    resolveRunUniverse: async () => ({
      fullDiff: universe.fullDiff,
      changedFiles: [...universe.changedFiles],
      preRunFiles: [],
    }),
  };
});

vi.mock('./drift/analyze.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./drift/analyze.js')>();
  return {
    ...actual,
    analyzeBriefDrift: (input: Parameters<typeof actual.analyzeBriefDrift>[0]) => {
      if (drift.fails) throw new Error('the ledger and the universe disagree');
      return actual.analyzeBriefDrift(input);
    },
  };
});

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  universe.fullDiff = '';
  universe.changedFiles = [];
  drift.fails = false;
});

function diffFor(path: string, body = '+export const login = () => null;'): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n${body}`;
}

/** A diff of exactly `chars` characters, header and all. */
function diffOfLength(path: string, chars: number): string {
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+`;
  return head + 'x'.repeat(chars - head.length);
}

/** A run whose every required source is present, for one field at a time. */
const WHOLE: ApiReviewContextInput = {
  pendingInputs: [],
  fixCycle: 1,
  feature: 'Add a login route',
  spec: '# Spec\n\nAdd a login route.\n',
  taskBriefs: '## T001 — login route\n\nWrite it.\n',
  fullDiff: diffFor('src/login.ts'),
  changedFiles: ['src/login.ts'],
  baseline: { head: 'abc1234', runStartChangedFiles: [] },
  driftSection: 'passed: true\nfindings: none',
  validation: { recorded: true, evidence: '- test (`npm test`): passed' },
  contextLength: 64_000,
};

function complete(overrides: Partial<ApiReviewContextInput> = {}) {
  const packet = buildApiReviewContext({ ...WHOLE, ...overrides });
  if (packet.kind !== 'complete') {
    throw new Error(`expected a complete packet, missing ${packet.missingSections.join(', ')}`);
  }
  return packet;
}

function refused(overrides: Partial<ApiReviewContextInput> = {}) {
  const packet = buildApiReviewContext({ ...WHOLE, ...overrides });
  if (packet.kind !== 'insufficient-context') throw new Error('expected a refused packet');
  return packet;
}

describe('the packet an API review seat is handed', () => {
  it('forwards the task review kind to the prompt', () => {
    expect(complete({ reviewKind: 'task' }).text).toContain('This is a task review.');
  });

  it('lists pending inputs only when the prompt has inputs to include', () => {
    expect(complete().manifest.map((entry) => entry.path)).not.toContain('pending inputs');
    const packet = complete({
      pendingInputs: [
        { id: 'P1', kind: 'defect', source: 'check', text: 'Typecheck failed', file: null },
      ],
    });
    expect(packet.manifest).toContainEqual({
      path: 'pending inputs',
      kind: 'required',
      state: 'included',
    });
    expect(packet.text).toContain('- **P1** (check · defect) — Typecheck failed');
  });

  it('sizes the rendered pending input section when required context is missing', () => {
    const empty = refused({ driftSection: '' });
    const packet = refused({
      driftSection: '',
      pendingInputs: [
        { id: 'P1', kind: 'defect', source: 'check', text: 'Typecheck failed', file: 'src/a.ts' },
      ],
    });
    const rendered =
      '## Pending Inputs\n- **P1** (check · defect) — Typecheck failed\n  File: src/a.ts';
    expect(packet.requiredTokens - empty.requiredTokens).toBe(estimateTokens(rendered));
  });

  it('sends a 100001-character diff whole when it fits', () => {
    const fullDiff = diffOfLength('src/big.ts', 100_001);
    expect(fullDiff).toHaveLength(100_001);

    const packet = complete({ fullDiff, changedFiles: ['src/big.ts'], contextLength: 200_000 });

    expect(packet.text).toContain(fullDiff);
    expect(packet.text).not.toContain('diff truncated');
    expect(packet.manifest).toContainEqual({
      path: 'src/big.ts',
      kind: 'required',
      state: 'included',
    });
  });

  it('refuses a diff too large for the seat instead of cutting it down', () => {
    const fullDiff = diffOfLength('src/big.ts', 100_001);
    const packet = refused({ fullDiff, changedFiles: ['src/big.ts'], contextLength: 10_000 });

    expect(packet.cause).toBe('input-budget');
    expect(packet.missingSections).toContain('run diff');
    expect(packet.requiredTokens).toBeGreaterThan(packet.availableTokens);
    expect(packet.manifest).toContainEqual({
      path: 'run diff',
      kind: 'required',
      state: 'omitted',
    });
  });

  it('reserves 2048 tokens of the seat window for the review’s own answer', () => {
    const measured = (contextLength: number | undefined): number =>
      refused({ contextLength, driftSection: '' }).availableTokens;

    expect(measured(10_000)).toBe(10_000 - 2_048);
    expect(measured(32_000)).toBe(32_000 - 2_048);
    // No configured window: the application default, minus the same reserve.
    expect(measured(undefined)).toBe(8_192 - 2_048);
  });

  it('refuses when the evidence ledger could not be read at all', () => {
    const packet = refused({ validation: { recorded: false, evidence: undefined } });

    expect(packet.cause).toBe('missing-required');
    expect(packet.missingSections).toEqual(['evidence.json']);
    expect(packet.manifest).toContainEqual({
      path: 'evidence.json',
      kind: 'required',
      state: 'missing',
    });
  });

  it('keeps a recorded skip visible, and states a ledger that recorded nothing', () => {
    const skipped = complete({
      validation: { recorded: true, evidence: '- test (`npm test`): skipped (no test command)' },
    });
    expect(skipped.text).toContain('- test (`npm test`): skipped (no test command)');

    const silent = complete({ validation: { recorded: true, evidence: undefined } });
    expect(silent.text).toContain('## Checks Log');
    expect(silent.text).toContain('- No checks recorded.');
    expect(silent.text).toContain('state that validation output was not recorded');
    expect(silent.manifest).toContainEqual({
      path: 'evidence.json',
      kind: 'required',
      state: 'included',
    });
  });

  it('refuses when this review has no drift of its own', () => {
    const packet = refused({ driftSection: undefined });

    expect(packet.cause).toBe('missing-required');
    expect(packet.missingSections).toEqual(['drift-report.json']);
  });

  it('reviews against the spec when the run wrote one, else against the original request', () => {
    const withSpec = complete({});
    expect(withSpec.manifest).toContainEqual({
      path: 'spec.md',
      kind: 'required',
      state: 'included',
    });

    const withoutSpec = complete({ spec: '' });
    expect(withoutSpec.text).toContain('This run wrote no specification.');
    expect(withoutSpec.text).toContain('Add a login route');
    expect(withoutSpec.manifest).toContainEqual({
      path: 'spec.md',
      kind: 'optional',
      state: 'missing',
    });
  });

  it('reads the diff’s own spelling of a path with a space or a non-ASCII name', () => {
    const spaced = 'docs/getting started.md';
    const accented = 'docs/café.md';
    const fullDiff = [
      diffFor(spaced, '+hello'),
      `diff --git "a/docs/caf\\303\\251.md" "b/docs/caf\\303\\251.md"\n--- "a/docs/caf\\303\\251.md"\n+++ "b/docs/caf\\303\\251.md"\n@@ -0,0 +1 @@\n+bonjour`,
    ].join('\n');

    const packet = complete({ fullDiff, changedFiles: [spaced, accented] });

    expect(packet.manifest).toContainEqual({ path: spaced, kind: 'required', state: 'included' });
    expect(packet.manifest).toContainEqual({ path: accented, kind: 'required', state: 'included' });
  });

  it('refuses a changed file the diff does not cover', () => {
    const packet = refused({ changedFiles: ['src/login.ts', 'src/ghost.ts'] });

    expect(packet.cause).toBe('missing-required');
    expect(packet.missingSections).toEqual(['src/ghost.ts']);
    expect(packet.manifest).toContainEqual({
      path: 'src/login.ts',
      kind: 'required',
      state: 'included',
    });
  });

  it('refuses a binary change whose contents it cannot review', () => {
    const fullDiff = `${diffFor('src/login.ts')}\ndiff --git a/logo.png b/logo.png\nindex 000..111 100644\nBinary files a/logo.png and b/logo.png differ\n`;
    const packet = refused({ fullDiff, changedFiles: ['src/login.ts', 'logo.png'] });

    expect(packet.cause).toBe('unsupported-required');
    expect(packet.missingSections).toEqual(['logo.png']);
    expect(packet.manifest).toContainEqual({
      path: 'logo.png',
      kind: 'required',
      state: 'unsupported',
    });
  });

  it('names the run baseline, the pre-run changes and the tools it does not have', () => {
    const packet = complete({
      changedFiles: ['src/login.ts'],
      baseline: { head: 'abc1234', runStartChangedFiles: ['src/login.ts'] },
    });

    expect(packet.text).toContain('Workspace comparison: commit abc1234');
    expect(packet.text).toContain('- src/login.ts — already modified before this run started');
    expect(packet.text).toContain('You have no filesystem, shell or search tool on this call');
  });

  it('refuses unsupported captured effects even when the current workspace is text', () => {
    const packet = refused({
      reviewScope: {
        files: [
          {
            path: 'logo.png',
            taskIds: ['T001'],
            diff: 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
          },
        ],
        laterDiff: '',
        workspaceContext: [],
        description: 'Recorded promotion.',
      },
    });
    expect(packet.cause).toBe('unsupported-required');
    expect(packet.missingSections).toContain('logo.png');
  });

  it('includes the whole promotion history in the API input budget', () => {
    const packet = refused({
      contextLength: 10_000,
      reviewScope: {
        files: [
          { path: 'src/login.ts', taskIds: ['T001'], diff: diffOfLength('src/login.ts', 100_001) },
        ],
        laterDiff: '',
        workspaceContext: [],
        description: 'Recorded promotion.',
      },
    });
    expect(packet.cause).toBe('input-budget');
    expect(packet.missingSections).toContain('recorded promotions');
  });

  it('carries the skills block, counted against the seat and named when it does not fit', () => {
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nREVIEW-SKILL-BODY';
    expect(complete({ skillsContext }).text).toContain(skillsContext);

    const packet = refused({ skillsContext: 's'.repeat(100_000), contextLength: 10_000 });
    expect(packet.cause).toBe('input-budget');
    expect(packet.missingSections).toContain('skills');
  });
});

/** A reviewer seat on its own local endpoint. No call ever reaches it. */
function apiReviewerConfig(contextLength = 64_000): Config {
  return makeNoValidationConfig({
    reviewer: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5',
      contextLength,
    },
  });
}

function setupRun(opts: { ledger: boolean }): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('api-review-context');
  dirs.push(projectDir);
  const sessionId = 'sess-api-review';
  ensureSessionDir(projectDir, sessionId);
  const ref = { projectDir, sessionId };
  writeSpecFile(ref, SPEC_FILE, '# Spec\n\nAdd a login route.\n', null);
  writeSpecFile(ref, TASKS_FILE, '## T001 — login route\n\nWrite it.\n', null);
  const task = makeTask({ id: 'T001', status: 'done' });
  if (opts.ledger) {
    writeEvidenceLedger(
      ref,
      createEvidenceLedger({
        sessionId,
        feature: 'Add a login route',
        tasks: [task],
      }),
    );
  }
  return ref;
}

async function review(opts: {
  projectDir: string;
  sessionId: string;
  config: Config;
  prompts: string[];
  skillsContext?: string;
}) {
  const reviewer = makePlanner({
    typedCall: typedCallPlanAndReview(
      () => planFromTasks([]),
      (prompt) => {
        opts.prompts.push(prompt);
        return passingReviewVerdict(prompt);
      },
    ),
  });
  const state = {
    ...makeImplState([makeTask({ id: 'T001', status: 'done' })]),
    changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
  };
  return runFinalReviewPhase({
    projectDir: opts.projectDir,
    workspaceDir: opts.projectDir,
    sessionId: opts.sessionId,
    config: opts.config,
    callbacks: makeCallbacks().callbacks,
    bus: makeBusRecorder().bus,
    state,
    reviewer,
    metadata: null,
    summaryBase: {
      feature: 'Add a login route',
      startTime: Date.now() - 1_000,
      plannerTool: 'ollama',
      implementerTool: 'ollama',
    },
    ...(opts.skillsContext !== undefined && { skillsContext: opts.skillsContext }),
  });
}

describe('a REVIEW seat that reads no files of its own', () => {
  it('reviews the complete packet, recomputing a drift report it never had', async () => {
    const ref = setupRun({ ledger: true });
    universe.fullDiff = diffFor('src/login.ts');
    universe.changedFiles = ['src/login.ts'];
    const prompts: string[] = [];
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), DRIFT_REPORT_FILE))).toBe(
      false,
    );

    const result = await review({ ...ref, config: apiReviewerConfig(), prompts });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(universe.fullDiff);
    expect(prompts[0]).toContain('Deterministic Drift Report');
    expect(prompts[0]).toContain('Workspace comparison files (1)');
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), DRIFT_REPORT_FILE))).toBe(
      true,
    );
    expect(result.reviewStatus).toBe('written');
    expect(result.verdict?.outcome.kind).toBe('pass');
    expect(result.failure).toBeUndefined();
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_FILE))).toBe(true);
  });

  it('fits a small run in the window a seat that configured none is given', async () => {
    const ref = setupRun({ ledger: true });
    const prompts: string[] = [];
    const config = makeNoValidationConfig({
      reviewer: {
        kind: 'api',
        provider: 'ollama',
        service: 'ollama',
        offering: 'local',
        apiBase: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5',
      },
    });

    const result = await review({ ...ref, config, prompts });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Workspace comparison files: none.');
    expect(result.reviewStatus).toBe('written');
  });

  it('dispatches nothing when a required source is missing from the packet', async () => {
    const ref = setupRun({ ledger: false });
    universe.fullDiff = diffFor('src/login.ts');
    universe.changedFiles = ['src/login.ts'];
    const prompts: string[] = [];

    const result = await review({ ...ref, config: apiReviewerConfig(), prompts });

    expect(prompts).toEqual([]);
    expect(result.reviewStatus).toBe('failed');
    expect(result.verdict).toBeNull();
    expect(result.failure).toEqual({
      kind: 'insufficient-context',
      diagnostic: {
        code: 'insufficient-context',
        seat: 'review',
        cause: 'missing-required',
        missingSections: ['evidence.json'],
        model: 'qwen2.5',
        requiredTokens: expect.any(Number),
        availableTokens: 64_000 - 2_048,
      },
    });
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_FILE))).toBe(false);
  });

  it('dispatches nothing when drift cannot be recomputed', async () => {
    const ref = setupRun({ ledger: true });
    universe.fullDiff = diffFor('src/login.ts');
    universe.changedFiles = ['src/login.ts'];
    drift.fails = true;
    const prompts: string[] = [];

    const result = await review({ ...ref, config: apiReviewerConfig(), prompts });

    expect(prompts).toEqual([]);
    expect(result.failure?.kind).toBe('insufficient-context');
    if (result.failure?.kind !== 'insufficient-context') return;
    expect(result.failure.diagnostic.cause).toBe('missing-required');
    expect(result.failure.diagnostic.missingSections).toEqual(['drift-report.json']);
    expect(result.reviewStatus).toBe('failed');
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_FILE))).toBe(false);
  });

  it('dispatches nothing when the run diff is larger than the seat', async () => {
    const ref = setupRun({ ledger: true });
    universe.fullDiff = diffOfLength('src/big.ts', 100_001);
    universe.changedFiles = ['src/big.ts'];
    const prompts: string[] = [];

    const result = await review({ ...ref, config: apiReviewerConfig(10_000), prompts });

    expect(prompts).toEqual([]);
    expect(result.failure?.kind).toBe('insufficient-context');
    if (result.failure?.kind !== 'insufficient-context') return;
    expect(result.failure.diagnostic.cause).toBe('input-budget');
    expect(result.failure.diagnostic.missingSections).toContain('run diff');
    expect(result.reviewStatus).toBe('failed');
    expect(result.verdict).toBeNull();
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_FILE))).toBe(false);
  });

  it('hands a CLI reviewer that reads no files the whole diff in its prompt, however long', async () => {
    const ref = setupRun({ ledger: false });
    universe.fullDiff = diffOfLength('src/big.ts', 150_000);
    universe.changedFiles = ['src/big.ts'];
    const prompts: string[] = [];
    const config = makeNoValidationConfig({ reviewer: { kind: 'cli', tool: 'codex' } });

    const result = await review({ ...ref, config, prompts });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('[... diff truncated,');
    expect(prompts[0]).toContain(universe.fullDiff);
    expect(result.reviewStatus).toBe('written');
    expect(result.failure).toBeUndefined();
  });

  it.each([
    { seat: 'an API reviewer', config: () => apiReviewerConfig() },
    { seat: 'a CLI reviewer', config: () => makeNoValidationConfig() },
  ])("hands $seat the run's skills context", async ({ config }) => {
    const ref = setupRun({ ledger: true });
    universe.fullDiff = diffFor('src/login.ts');
    universe.changedFiles = ['src/login.ts'];
    const prompts: string[] = [];
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nREVIEW-SKILL-BODY';

    await review({ ...ref, config: config(), prompts, skillsContext });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(skillsContext);
  });
});
