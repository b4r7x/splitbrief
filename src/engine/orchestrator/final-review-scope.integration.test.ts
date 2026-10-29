import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { makeCommandRunner } from '#testing/helpers/validation-fixtures.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  failedReviewVerdict,
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import {
  DRIFT_REPORT_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  reviewChangeFile,
  SPEC_FILE,
  sessionDir,
} from '../../core/paths.js';
import { REVIEW_CHANGES_FILE } from '../../core/evidence/review-changes.js';
import { ReviewPacketSchema } from '../../core/schemas/review-packet.js';
import type { Check } from '../../core/schemas/task.js';
import { saveState } from '../../core/state/persistence.js';
import { applyConsultAnswer } from './consult/apply.js';
import {
  getChangedFilesSinceSnapshot,
  getChangedFilesSnapshot,
} from './approval/file-snapshots/capture.js';
import { captureTaskReviewChanges } from './evidence/review-capture.js';
import { getOrCreateLedger } from './evidence/persistence.js';
import { writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { resolveRunReviewScope } from './evidence/review-packet/run-scope.js';
import { createSnapshot } from '../snapshots/create.js';
import { runFinalReviewPhase } from './final-review.js';

const cleanups: Array<() => void> = [];
const file = 'src/mixed.ts';
const operator = 'export const operatorFix = true;\nexport const feature = false;\n';
const worker = operator.replace('feature = false', 'feature = true');

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function project() {
  const projectDir = createTempDir('review-scope');
  cleanups.push(() => cleanupTempDir(projectDir));
  // An unborn repository supports these reads without creating a commit or index.
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, file), operator);
  writeFileSync(join(projectDir, 'src/tool-fix.ts'), 'export const independentFix = true;\n');
  const ref = { projectDir, sessionId: 'scope-test' };
  ensureSessionDir(projectDir, ref.sessionId);
  const task = makeTask({ suggestedFiles: [file], action: 'modify', status: 'in_progress' });
  // The run base: the operator's edits are already there when the run starts.
  await createSnapshot({ ...ref, phase: 'manual', name: 'run-baseline' });
  const base = await createSnapshot({ ...ref, phase: 'manual', name: 'workspace-base' });
  const workspace = {
    kind: 'checkout' as const,
    path: projectDir,
    base: { snapshotId: base.manifest.id, head: null },
  };
  return { ...ref, ref, task, workspace };
}

async function completeTask(
  p: Awaited<ReturnType<typeof project>>,
  text = worker,
  extra?: string,
  task = p.task,
) {
  const taskStartSnapshot = await getChangedFilesSnapshot(p.projectDir);
  writeFileSync(join(p.projectDir, file), text);
  if (extra !== undefined) writeFileSync(join(p.projectDir, extra), 'export {};\n');
  await captureTaskReviewChanges({
    ref: p.ref,
    workspaceDir: p.projectDir,
    task,
    since: taskStartSnapshot,
    files: await getChangedFilesSinceSnapshot(p.projectDir, taskStartSnapshot),
  });
  // A passed task leaves its evidence ledger, which the review packet requires.
  writeEvidenceLedger(p.ref, getOrCreateLedger({ ref: p.ref, state: makeImplState([task]) }));
}

/** The change is in the prompt of an API reviewer and in the change file of a Claude Code one. */
async function review(p: Awaited<ReturnType<typeof project>>, api = false, tasks = [p.task]) {
  const prompts: string[] = [];
  writeSpecFile(p.ref, SPEC_FILE, 'Enable feature; preserve operator fixes.', null);
  const result = await runFinalReviewPhase({
    ...p,
    workspaceDir: p.projectDir,
    state: makeImplState(
      tasks.map((task) => ({ ...task, status: 'done' as const })),
      {
        changedFilesBaseline: { head: null, runStartChangedFiles: [file], fingerprints: {} },
        workspace: p.workspace,
      },
    ),
    config: makeNoValidationConfig(
      api
        ? {
            reviewer: {
              kind: 'api',
              provider: 'custom-endpoint',
              service: 'custom-endpoint',
              offering: 'payg',
              model: 'test-reviewer',
              apiBase: 'https://unused.example/v1',
              apiKey: 'unused',
            },
          }
        : {},
    ),
    bus: makeBusRecorder().bus,
    callbacks: makeCallbacks().callbacks,
    reviewer: makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt) => {
          prompts.push(prompt);
          return failedReviewVerdict(prompt, 'Test review failure.', { taskId: 'T001' });
        },
      ),
    }),
    metadata: TEST_METADATA,
    summaryBase: {
      feature: 'feature',
      startTime: Date.now(),
      plannerTool: 'test',
      implementerTool: 'test',
    },
  });
  expect(result.verdict?.outcome.kind).toBe('fail');
  expect(prompts).toHaveLength(1);
  const packet = ReviewPacketSchema.parse(
    JSON.parse(
      readFileSync(join(sessionDir(p.projectDir, p.sessionId), REVIEW_PACKET_JSON_FILE), 'utf8'),
    ),
  );
  const prompt = prompts[0] ?? '';
  const change = api
    ? prompt
    : readFileSync(join(p.projectDir, reviewChangeFile(p.sessionId)), 'utf8');
  return { prompt, change, packet };
}

describe('final review task completion provenance', () => {
  it('emits task review notes when every finding is out of scope', async () => {
    const p = await project();
    await completeTask(p);
    const { bus, events } = makeBusRecorder();
    const result = await runFinalReviewPhase({
      ...p,
      workspaceDir: p.projectDir,
      scope: 'task',
      afterTaskId: p.task.id,
      state: makeImplState([{ ...p.task, status: 'done' }], {
        changedFilesBaseline: { head: null, runStartChangedFiles: [file], fingerprints: {} },
        workspace: p.workspace,
      }),
      config: makeNoValidationConfig(),
      bus,
      callbacks: makeCallbacks().callbacks,
      reviewer: makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt) => ({
            ...passingReviewVerdict(prompt),
            findings: [1, 2].map((id) => ({
              id: `F${id}`,
              kind: 'defect',
              severity: 'blocking',
              taskId: 'T002',
              file: 'src/later.ts',
              line: id,
              text: `Later task defect ${id}`,
              acceptance: null,
              checkIds: null,
              criterionId: null,
            })),
          }),
        ),
      }),
      metadata: TEST_METADATA,
    });

    expect(result.reviewStatus).toBe('written');
    expect(result.verdict?.outcome.kind).toBe('pass-with-notes');
    expect(events.filter((event) => event.type === 'review_completed')).toEqual([
      expect.objectContaining({
        scope: 'task',
        afterTaskId: 'T001',
        verdict: 'pass-with-notes',
        findings: { blocking: 0, minor: 0, outOfScope: 2 },
      }),
    ]);
    expect(existsSync(join(p.projectDir, '.git', 'index'))).toBe(false);
  });

  it.each([false, true])(
    'separates mixed-file and independent operator hunks for API=%s',
    async (api) => {
      const p = await project();
      await completeTask(p);
      const { prompt, change, packet } = await review(p, api);
      const implementation =
        change.split('## Implementation Diff')[1]?.split('## Workspace Context')[0] ?? '';
      expect(implementation).toContain(`### ${file} — T001`);
      expect(implementation).toContain('+export const feature = true;');
      expect(implementation).not.toContain('operatorFix');
      expect(implementation).not.toContain('independentFix');
      // The context carries only files with no recorded run effect, so no hunk is shown twice.
      const context = change.split('## Workspace Context')[1] ?? '';
      expect(context).toContain('independentFix');
      expect(context).not.toContain(`b/${file}`);
      expect(change.split('+export const feature = true;')).toHaveLength(2);
      expect(prompt).toContain('including when they share a declared file');
      expect(packet.changes.provenance).toMatchObject({
        status: 'available',
        promotedFiles: [file],
        uncertainFiles: ['src/tool-fix.ts'],
      });
      const drift = JSON.parse(
        readFileSync(join(sessionDir(p.projectDir, p.sessionId), DRIFT_REPORT_FILE), 'utf8'),
      );
      expect(drift.changedFiles).toEqual([file]);
      expect(
        drift.findings.some((finding: { code: string }) => finding.code === 'out_of_scope_file'),
      ).toBe(false);
      expect(existsSync(join(p.projectDir, '.git', 'index'))).toBe(false);
      const markdown = readFileSync(
        join(sessionDir(p.projectDir, p.sessionId), REVIEW_PACKET_MARKDOWN_FILE),
        'utf8',
      );
      expect(markdown).toContain('Workspace context: src/mixed.ts, src/tool-fix.ts');
    },
  );

  it('names the file a brief created when verify completes it after a retry', async () => {
    const p = await project();
    const created = 'src/created.ts';
    const checks: Check[] = [{ id: 'K1', kind: 'cmd', value: 'tsc --noEmit', required: true }];
    const task = makeTask({
      suggestedFiles: [created],
      action: 'create',
      status: 'failed',
      criteria: [],
    });
    const taskStartSnapshot = await getChangedFilesSnapshot(p.projectDir);
    writeFileSync(join(p.projectDir, created), 'export const created = true;\n');
    // The retry before the consult starts after the file landed and changes nothing.
    const attempt = await getChangedFilesSnapshot(p.projectDir);
    const state = {
      ...makeImplState([task], {
        plan: {
          summary: 'Create the file',
          decisions: [],
          criteria: [{ id: 'C1', text: 'The file exists', checkIds: ['K1'] }],
          checks,
          validation: null,
        },
        changedFilesBaseline: { head: null, runStartChangedFiles: [file], fingerprints: {} },
        workspace: p.workspace,
      }),
      phase: 'escalating' as const,
      attempt: 1,
    };
    saveState(p.ref, state);
    const applied = await applyConsultAnswer(
      {
        ...p.ref,
        workspaceDir: p.projectDir,
        bus: makeBusRecorder().bus,
        config: makeNoValidationConfig(),
        validator: { formatChangedFiles: vi.fn().mockResolvedValue(undefined) },
        callbacks: makeCallbacks().callbacks,
        sinks: TEST_SINKS,
        state,
        seat: 'plan',
        changedFiles: [],
        taskStartSnapshot,
        runCommand: makeCommandRunner({ stdout: 'clean', stderr: '', code: 0 }),
      },
      task,
      {
        answer: {
          diagnosis: 'The file is already in the workspace.',
          action: 'verify',
          checkIds: ['K1'],
          reason: 'K1 covers the file.',
        },
      },
      attempt,
    );
    expect(applied.action).toBe('completed');
    writeEvidenceLedger(p.ref, getOrCreateLedger({ ref: p.ref, state: makeImplState([task]) }));

    const { packet } = await review(p, false, [task]);

    expect(packet.changes.provenance).toMatchObject({ promotedFiles: [created] });
    const drift = JSON.parse(
      readFileSync(join(sessionDir(p.projectDir, p.sessionId), DRIFT_REPORT_FILE), 'utf8'),
    );
    expect(drift.findings).not.toContainEqual(
      expect.objectContaining({ code: 'missing_expected_file' }),
    );
  });

  it('keeps overlapping edits after capture explicit without erasing the run effect', async () => {
    const p = await project();
    await completeTask(p);
    writeFileSync(join(p.projectDir, file), 'operator changed the same feature line\n');
    const { change, packet } = await review(p);
    expect(change).toContain('+export const feature = true;');
    expect(change).toContain('operator changed the same feature line');
    expect(change).toContain('Changes after the last recorded task completion; authorship unknown');
    expect(change.split('operator changed the same feature line')).toHaveLength(2);
    expect(packet.changes.provenance?.uncertainFiles).toContain(file);
  });

  it.each(['missing', 'invalid'])(
    'labels %s legacy evidence and retains every workspace edit since the run started',
    async (state) => {
      const p = await project();
      if (state === 'invalid')
        writeFileSync(join(sessionDir(p.projectDir, p.sessionId), REVIEW_CHANGES_FILE), '{}');
      const { prompt, change, packet } = await review(p);
      expect(packet.changes.provenance?.status).toBe(state);
      expect(prompt).toContain('not evidence of an empty run');
      expect(change).toContain('independentFix');
      // The operator's edit was there when the run started, so it is context, not a run change.
      expect(change).not.toContain('operatorFix');
      expect(prompt).not.toContain('operatorFix');
      expect(prompt).toContain(`Files already changed when this run started: ${file}.`);
      expect(packet.changes.provenance?.uncertainFiles).toEqual(['src/tool-fix.ts']);
      expect(packet.changes.provenance?.preRunFiles).toEqual([file]);
    },
  );

  it('names a completed task file no brief suggested in the Changed Files section', async () => {
    const p = await project();
    await completeTask(p, worker, 'src/shared.ts');
    const scope = await resolveRunReviewScope({
      ref: p.ref,
      workspaceDir: p.ref.projectDir,
      tasks: [p.task],
      workspaceFiles: [],
      workspaceDiff: '',
      preRunFiles: [],
    });
    expect(scope.description).toContain(
      'Files touched, not suggested by any brief: src/shared.ts.',
    );
  });

  it('retains mode changes and deletions in the run diff of a file', async () => {
    const p = await project();
    const scoped = () =>
      resolveRunReviewScope({
        ref: p.ref,
        workspaceDir: p.ref.projectDir,
        tasks: [p.task],
        workspaceFiles: [],
        workspaceDiff: '',
        preRunFiles: [],
      });
    const capture = async (change: () => void) => {
      const taskStartSnapshot = await getChangedFilesSnapshot(p.projectDir);
      change();
      await captureTaskReviewChanges({
        ref: p.ref,
        workspaceDir: p.projectDir,
        task: p.task,
        since: taskStartSnapshot,
        files: await getChangedFilesSinceSnapshot(p.projectDir, taskStartSnapshot),
      });
    };
    await capture(() => chmodSync(join(p.projectDir, file), 0o755));
    expect((await scoped()).files[0]?.diff).toContain('new mode 100755');
    await capture(() => rmSync(join(p.projectDir, file)));
    const scope = await scoped();
    expect(scope.files.map((entry) => [entry.path, entry.taskIds])).toEqual([[file, ['T001']]]);
    expect(scope.files[0]?.diff).toContain('deleted file mode 100644');
    expect(scope.provenance.promotedFiles).toEqual([file]);
  });

  it('shows a file two tasks touched once, attributed to both, with each hunk once', async () => {
    const p = await project();
    const second = makeTask({
      id: 'T002',
      suggestedFiles: [file],
      action: 'modify',
      status: 'in_progress',
    });
    await completeTask(p);
    await completeTask(p, `${worker}export const extra = 2;\n`, undefined, second);

    const scope = await resolveRunReviewScope({
      ref: p.ref,
      workspaceDir: p.ref.projectDir,
      tasks: [p.task, second],
      workspaceFiles: [file],
      workspaceDiff: '',
      preRunFiles: [],
    });
    expect(scope.files.map((entry) => [entry.path, entry.taskIds])).toEqual([
      [file, ['T001', 'T002']],
    ]);
    const diff = scope.files[0]?.diff ?? '';
    expect(diff.split('+export const feature = true;')).toHaveLength(2);
    expect(diff.split('+export const extra = 2;')).toHaveLength(2);

    const { change } = await review(p, false, [p.task, second]);
    expect(change.split(`### ${file} — T001, T002`)).toHaveLength(2);
    expect(change.split('+export const feature = true;')).toHaveLength(2);
    expect(change.split('+export const extra = 2;')).toHaveLength(2);
  });

  it('shows a later edit of a file whose run effect cancelled out once', async () => {
    const p = await project();
    const second = makeTask({
      id: 'T002',
      suggestedFiles: [file],
      action: 'modify',
      status: 'in_progress',
    });
    await completeTask(p);
    await completeTask(p, operator, undefined, second);
    writeFileSync(join(p.projectDir, file), `${operator}export const later = 'edit';\n`);

    const { change } = await review(p, false, [p.task, second]);

    expect(change.split("export const later = 'edit';")).toHaveLength(2);
  });

  it('writes the change file of a task review with the reviewed task', async () => {
    const p = await project();
    await completeTask(p);

    const prompts: string[] = [];

    const result = await runFinalReviewPhase({
      ...p,
      workspaceDir: p.projectDir,
      scope: 'task',
      afterTaskId: p.task.id,
      state: makeImplState([{ ...p.task, status: 'done' }], {
        changedFilesBaseline: { head: null, runStartChangedFiles: [file], fingerprints: {} },
        workspace: p.workspace,
      }),
      config: makeNoValidationConfig(),
      bus: makeBusRecorder().bus,
      callbacks: makeCallbacks().callbacks,
      reviewer: makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt) => {
            prompts.push(prompt);
            return passingReviewVerdict(prompt);
          },
        ),
      }),
      metadata: TEST_METADATA,
    });

    const changeFile = join(p.projectDir, reviewChangeFile(p.sessionId));
    const change = readFileSync(changeFile, 'utf8');
    expect(result.reviewStatus).toBe('written');
    expect(prompts[0]).toContain(changeFile);
    expect(change).toContain(`### ${file} — T001`);
    expect(change).toContain('+export const feature = true;');
  });

  it('lists the fix task beside the task it fixes in the change file of a re-review', async () => {
    const p = await project();
    const fix = makeTask({
      id: 'T002',
      suggestedFiles: [file],
      action: 'modify',
      status: 'in_progress',
      fix: {
        cycle: 1,
        findings: [{ id: 'F1', text: 'Export the extra value.', acceptance: null }],
      },
    });
    await completeTask(p);
    await completeTask(p, `${worker}export const extra = 2;\n`, undefined, fix);

    const { change } = await review(p, false, [p.task, fix]);

    expect(change).toContain(`### ${file} — T001, T002`);
    expect(change).toContain('+export const extra = 2;');
  });

  it('keeps a file whose run effect cancelled out uncertain when it was edited afterwards', async () => {
    const p = await project();
    const second = makeTask({
      id: 'T002',
      suggestedFiles: [file],
      action: 'modify',
      status: 'in_progress',
    });
    await completeTask(p);
    await completeTask(p, operator, undefined, second);
    writeFileSync(join(p.projectDir, file), 'export const restored = true;\n');

    const scope = await resolveRunReviewScope({
      ref: p.ref,
      workspaceDir: p.ref.projectDir,
      tasks: [p.task, second],
      workspaceFiles: [],
      workspaceDiff: '',
      preRunFiles: [],
    });

    expect(scope.files).toEqual([]);
    expect(scope.laterDiff).toBe('');
    expect(scope.provenance.uncertainFiles).toContain(file);
  });

  it('does not adopt evidence for a rewound brief that reuses an ID', async () => {
    const p = await project();
    await completeTask(p);
    const scope = await resolveRunReviewScope({
      ref: p.ref,
      workspaceDir: p.ref.projectDir,
      tasks: [{ ...p.task, description: 'different brief' }],
      workspaceFiles: [file],
      workspaceDiff: '',
      preRunFiles: [],
    });
    expect(scope.files).toEqual([]);
    expect(scope.provenance.uncertainFiles).toEqual([file]);
  });
});
