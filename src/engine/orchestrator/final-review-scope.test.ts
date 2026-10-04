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
} from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import {
  DRIFT_REPORT_FILE,
  REVIEW_PACKET_JSON_FILE,
  REVIEW_PACKET_MARKDOWN_FILE,
  SPEC_FILE,
  sessionDir,
} from '../../core/paths.js';
import { REVIEW_CHANGES_FILE } from '../../core/evidence/review-changes.js';
import { ReviewPacketSchema } from '../../core/schemas/review-packet.js';
import { getChangedFilesSnapshot } from './approval/file-snapshots/capture.js';
import { captureTaskReviewChanges } from './evidence/review-capture.js';
import { getOrCreateLedger } from './evidence/persistence.js';
import { writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { resolveRunReviewScope } from './evidence/review-packet/run-scope.js';
import { runFinalReviewPhase } from './final-review.js';

const cleanups: Array<() => void> = [];
const file = 'src/mixed.ts';
const operator = 'export const operatorFix = true;\nexport const feature = false;\n';
const worker = operator.replace('feature = false', 'feature = true');

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function project() {
  const projectDir = createTempDir('review-scope');
  cleanups.push(() => cleanupTempDir(projectDir));
  // An unborn repository supports these reads without creating a commit or index.
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  mkdirSync(join(projectDir, 'src'));
  writeFileSync(join(projectDir, file), operator);
  writeFileSync(join(projectDir, 'src/tool-fix.ts'), 'export const independentFix = true;\n');
  const ref = { projectDir, sessionId: 'scope-test' };
  ensureSessionDir(projectDir, ref.sessionId);
  const task = makeTask({ file, action: 'modify', status: 'in_progress' });
  return { ...ref, ref, task };
}

async function completeTask(p: ReturnType<typeof project>, text = worker, extra?: string) {
  const taskStartSnapshot = await getChangedFilesSnapshot(p.projectDir);
  writeFileSync(join(p.projectDir, file), text);
  if (extra !== undefined) writeFileSync(join(p.projectDir, extra), 'export {};\n');
  await captureTaskReviewChanges({
    ref: p.ref,
    workspaceDir: p.projectDir,
    task: p.task,
    taskStartSnapshot,
  });
  // A passed task leaves its evidence ledger, which the review packet requires.
  writeEvidenceLedger(p.ref, getOrCreateLedger({ ref: p.ref, state: makeImplState([p.task]) }));
}

async function review(p: ReturnType<typeof project>, api = false) {
  const prompts: string[] = [];
  writeSpecFile(p.ref, SPEC_FILE, 'Enable feature; preserve operator fixes.', null);
  const result = await runFinalReviewPhase({
    ...p,
    workspaceDir: p.projectDir,
    state: makeImplState([{ ...p.task, status: 'done' }], {
      changedFilesBaseline: { head: null, runStartChangedFiles: [file], fingerprints: {} },
    }),
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
      review: async (prompt) => {
        prompts.push(prompt);
        return {
          text: '### Verdict\nfail\n\n### Findings\n- **Critical**: Test review failure.\n',
          usage: null,
        };
      },
    }),
    metadata: TEST_METADATA,
    summaryBase: {
      feature: 'feature',
      startTime: Date.now(),
      plannerTool: 'test',
      implementerTool: 'test',
    },
    taskBreakdowns: [],
  });
  expect(result.verdict?.verdict).toBe('fail');
  expect(prompts).toHaveLength(1);
  const packet = ReviewPacketSchema.parse(
    JSON.parse(
      readFileSync(join(sessionDir(p.projectDir, p.sessionId), REVIEW_PACKET_JSON_FILE), 'utf8'),
    ),
  );
  return { prompt: prompts[0] ?? '', packet };
}

describe('final review task completion provenance', () => {
  it.each([false, true])(
    'separates mixed-file and independent operator hunks for API=%s',
    async (api) => {
      const p = project();
      await completeTask(p);
      const { prompt, packet } = await review(p, api);
      const implementation =
        prompt.split('## Implementation Diff')[1]?.split('## Workspace Context')[0] ?? '';
      expect(implementation).toContain('+export const feature = true;');
      expect(implementation).not.toContain('operatorFix');
      expect(implementation).not.toContain('independentFix');
      expect(prompt.split('## Workspace Context')[1]).toContain('operatorFix');
      expect(prompt).toContain('independentFix');
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

  it('keeps overlapping edits after capture explicit without erasing the run effect', async () => {
    const p = project();
    await completeTask(p);
    writeFileSync(join(p.projectDir, file), 'operator changed the same feature line\n');
    const { prompt, packet } = await review(p);
    expect(prompt).toContain('+export const feature = true;');
    expect(prompt).toContain('operator changed the same feature line');
    expect(prompt).toContain('Changes after the last recorded task completion; authorship unknown');
    expect(packet.changes.provenance?.uncertainFiles).toContain(file);
  });

  it.each(['missing', 'invalid'])(
    'labels %s legacy evidence and retains all workspace edits',
    async (state) => {
      const p = project();
      if (state === 'invalid')
        writeFileSync(join(sessionDir(p.projectDir, p.sessionId), REVIEW_CHANGES_FILE), '{}');
      const { prompt, packet } = await review(p);
      expect(packet.changes.provenance?.status).toBe(state);
      expect(prompt).toContain('not evidence of an empty run');
      expect(prompt).toContain('operatorFix');
      expect(prompt).toContain('independentFix');
      expect(packet.changes.provenance?.uncertainFiles).toEqual([file, 'src/tool-fix.ts']);
    },
  );

  it('names a completed task file no brief suggested in the Changed Files section', async () => {
    const p = project();
    await completeTask(p, worker, 'src/shared.ts');
    const scope = await resolveRunReviewScope({
      ref: p.ref,
      workspaceDir: p.ref.projectDir,
      tasks: [p.task],
      workspaceFiles: [],
    });
    expect(scope.description).toContain(
      'Files touched, not suggested by any brief: src/shared.ts.',
    );
  });

  it('retains deletion and mode changes in the captured review diff', async () => {
    const p = project();
    for (const next of ['mode', 'delete']) {
      const taskStartSnapshot = await getChangedFilesSnapshot(p.projectDir);
      if (next === 'mode') chmodSync(join(p.projectDir, file), 0o755);
      else rmSync(join(p.projectDir, file));
      await captureTaskReviewChanges({
        ref: p.ref,
        workspaceDir: p.projectDir,
        task: p.task,
        taskStartSnapshot,
      });
    }
    const scope = await resolveRunReviewScope({
      ref: p.ref,
      workspaceDir: p.ref.projectDir,
      tasks: [p.task],
      workspaceFiles: [],
    });
    expect(scope.diff).toContain('new mode 100755');
    expect(scope.diff).toContain('deleted file mode 100755');
    expect(scope.provenance.promotedFiles).toEqual([file]);
  });

  it('does not adopt evidence for a rewound brief that reuses an ID', async () => {
    const p = project();
    await completeTask(p);
    const scope = await resolveRunReviewScope({
      ref: p.ref,
      workspaceDir: p.ref.projectDir,
      tasks: [{ ...p.task, description: 'different brief' }],
      workspaceFiles: [file],
    });
    expect(scope.diff).toBe('');
    expect(scope.provenance.uncertainFiles).toEqual([file]);
  });
});
