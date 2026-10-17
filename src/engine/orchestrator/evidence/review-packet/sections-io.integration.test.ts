import { setupProject } from '#testing/helpers/planning-phase.js';
import { writeSpecFile } from '../../../../core/paths-io.js';
import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo, recordGitLaunches } from '#testing/helpers/git.js';
import type { DriftReport } from '../../../../core/schemas/drift.js';
import { REVIEW_FILE, REVIEW_JSON_FILE, sessionDir } from '../../../../core/paths.js';
import type { ReviewPacket } from '../../../../core/schemas/review-packet.js';
import { buildFinalReview, resolveChangedFiles, resolveRunUniverse } from './sections-io.js';
import { renderReviewPacketMarkdown } from './render.js';
import { makeReviewPacket } from '#testing/helpers/factories/review-packet.js';
import { NULL_CACHE } from '../../../providers/model/resolution.js';
import { createSnapshot } from '../../../snapshots/create.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function makeProject(files: Record<string, string> = {}): {
  projectDir: string;
  runStartHead: string;
} {
  const projectDir = createTempDir('sections-io-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir, files);
  const runStartHead = execSync('git rev-parse HEAD', {
    cwd: projectDir,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  return { projectDir, runStartHead };
}

function driftWith(changedFiles: string[]): DriftReport {
  return {
    version: 1,
    passed: true,
    changedFiles,
    expectedFiles: [],
    findings: [],
    briefHash: null,
  };
}

describe('resolveChangedFiles', () => {
  it('uses the drift report changed files (deduped, sorted) without consulting git or reporting missing', async () => {
    const { projectDir, runStartHead } = makeProject();
    const missing: string[] = [];

    const files = await resolveChangedFiles({
      workspaceDir: projectDir,
      runBase: undefined,
      drift: driftWith(['src/b.ts', 'src/a.ts', 'src/a.ts']),
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(missing).toEqual([]);
  });

  it('reports "changed files" missing instead of an empty-but-confident list when no drift report and the tree is clean', async () => {
    const { projectDir, runStartHead } = makeProject();
    const missing: string[] = [];

    const files = await resolveChangedFiles({
      workspaceDir: projectDir,
      runBase: undefined,
      drift: null,
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toEqual([]);
    expect(missing).toContain('changed files');
  });

  it('reports the run-start baseline missing instead of guessing the run boundary from git history', async () => {
    const { projectDir } = makeProject();
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const x = 1;\n');
    git('add src/feature.ts');
    git('commit -m "feat(splitbrief): T1 - add feature"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      workspaceDir: projectDir,
      runBase: undefined,
      drift: null,
      missing,
      baseline: undefined,
    });

    expect(files).toEqual([]);
    expect(missing).toEqual(['run-start baseline']);
  });

  it('surfaces files committed since run-start when per-task commits leave a clean working tree', async () => {
    const { projectDir, runStartHead } = makeProject();
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    // A per-task commit (prefixed `feat(splitbrief):`) moves the run's change out of
    // the working tree, leaving `git status` empty.
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const x = 1;\n');
    git('add src/feature.ts');
    git('commit -m "feat(splitbrief): T1 - add feature"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      workspaceDir: projectDir,
      runBase: undefined,
      drift: null,
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toEqual(['src/feature.ts']);
    expect(missing).not.toContain('changed files');
  });

  it('routes the no-drift fallback through the run-baseline filter, dropping splitbrief-internal paths', async () => {
    const { projectDir, runStartHead } = makeProject();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/feature.ts'), 'export const x = 1;\n');
    // An internal control-plane write that must NOT surface as a changed file.
    mkdirSync(join(projectDir, '.splitbrief', 'sessions'), { recursive: true });
    writeFileSync(join(projectDir, '.splitbrief', 'sessions', 'state.json'), '{}\n');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      workspaceDir: projectDir,
      runBase: undefined,
      drift: null,
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toContain('src/feature.ts');
    expect(files.some((f) => f.startsWith('.splitbrief'))).toBe(false);
    expect(missing).not.toContain('changed files');
  });

  it('uses the persisted run boundary for no-drift review packets', async () => {
    const { projectDir } = makeProject();
    const git = (args: string) =>
      execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe', encoding: 'utf8' }).trim();
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/pre-run.ts'), 'export const preRun = true;\n');
    git('add src/pre-run.ts');
    git('commit -m "feat(splitbrief): misleading pre-run subject"');
    const runStartHead = git('rev-parse HEAD');

    writeFileSync(join(projectDir, 'src/post-run.ts'), 'export const postRun = true;\n');
    git('add src/post-run.ts');
    git('commit -m "chore: arbitrary post-run subject"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      workspaceDir: projectDir,
      runBase: undefined,
      drift: null,
      missing,
      baseline: { head: runStartHead },
    });

    expect(files).toEqual(['src/post-run.ts']);
    expect(missing).not.toContain('changed files');
  });

  it('includes commits from an explicitly captured unborn boundary', async () => {
    const { projectDir } = makeProject();
    const git = (args: string) => execSync(`git ${args}`, { cwd: projectDir, stdio: 'pipe' });
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/from-unborn.ts'), 'export const value = true;\n');
    git('add src/from-unborn.ts');
    git('commit -m "chore: arbitrary subject"');

    const missing: string[] = [];
    const files = await resolveChangedFiles({
      workspaceDir: projectDir,
      runBase: undefined,
      drift: null,
      missing,
      baseline: { head: null },
    });

    expect(files).toContain('src/from-unborn.ts');
    expect(missing).not.toContain('changed files');
  });

  it('lists the changed files without building a diff of the untracked files', async () => {
    const { projectDir, runStartHead } = makeProject();
    writeFileSync(join(projectDir, 'init.txt'), 'changed');
    writeFileSync(join(projectDir, 'new-a.txt'), 'a');
    writeFileSync(join(projectDir, 'new-b.txt'), 'b');
    const git = recordGitLaunches();
    try {
      const files = await resolveChangedFiles({
        workspaceDir: projectDir,
        runBase: undefined,
        drift: null,
        missing: [],
        baseline: { head: runStartHead },
      });
      expect(files).toEqual(['init.txt', 'new-a.txt', 'new-b.txt']);
      expect(git.launches().filter((args) => args.startsWith('diff '))).toEqual([
        `diff --no-renames --name-only -z ${runStartHead} HEAD`,
      ]);
    } finally {
      git.restore();
    }
  });
});

describe('resolveRunUniverse', () => {
  it('reads git status once for the changed files and the diff', async () => {
    const { projectDir, runStartHead } = makeProject();
    writeFileSync(join(projectDir, 'init.txt'), 'CHANGED_BODY');
    writeFileSync(join(projectDir, 'new-a.txt'), 'UNTRACKED_BODY');
    const git = recordGitLaunches();
    try {
      const universe = await resolveRunUniverse({
        workspaceDir: projectDir,
        baseline: { head: runStartHead },
        runBase: undefined,
      });
      expect(universe.changedFiles).toEqual(['init.txt', 'new-a.txt']);
      expect(universe.fullDiff).toContain('CHANGED_BODY');
      expect(universe.fullDiff).toContain('UNTRACKED_BODY');
      expect(git.launches().filter((args) => args.startsWith('status'))).toHaveLength(1);
    } finally {
      git.restore();
    }
  });

  it("takes isolation's own .gitignore lines for no change, and the run's for one", async () => {
    const committed = 'node_modules\n';
    const { projectDir, runStartHead } = makeProject({ '.gitignore': committed });
    writeFileSync(join(projectDir, '.gitignore'), `${committed}.splitbrief/\n.trees/\n`);
    const baseline = { head: runStartHead, runStartChangedFiles: [] };

    const untouched = await resolveRunUniverse({
      workspaceDir: projectDir,
      baseline,
      runBase: undefined,
    });
    expect(untouched.changedFiles).toEqual([]);
    expect(untouched.fullDiff).toBe('');
    expect(untouched.setupFiles).toEqual(['.gitignore']);
    expect(untouched.preRunFiles).toEqual([]);

    writeFileSync(join(projectDir, '.gitignore'), `${committed}.splitbrief/\n.trees/\ndist/\n`);
    const changed = await resolveRunUniverse({
      workspaceDir: projectDir,
      baseline,
      runBase: undefined,
    });
    expect(changed.changedFiles).toEqual(['.gitignore']);
    expect(changed.fullDiff).toContain('+dist/');
    expect(changed.setupFiles).toEqual([]);
  });
});

describe('resolveRunUniverse on a checkout changed before the run', () => {
  async function dirtyRun() {
    const { projectDir, runStartHead } = makeProject();
    writeFileSync(join(projectDir, 'init.txt'), 'USER_EDIT\n');
    writeFileSync(join(projectDir, 'user-script.mjs'), 'USER_SCRIPT\n');
    writeFileSync(join(projectDir, 'shared.txt'), 'USER_LINE\n');
    chmodSync(join(projectDir, 'user-script.mjs'), 0o755);
    // Latin-1 text: its bytes are no valid UTF-8.
    writeFileSync(join(projectDir, 'latin.txt'), Buffer.from('caf\xe9\n', 'latin1'));
    const ref = { projectDir, sessionId: 'dirty-run' };
    await createSnapshot({ ...ref, phase: 'manual', name: 'run-baseline' });
    const base = await createSnapshot({ ...ref, phase: 'manual', name: 'workspace-base' });
    const runBase = { ...ref, snapshotId: base.manifest.id, head: runStartHead };
    const baseline = {
      head: runStartHead,
      runStartChangedFiles: ['init.txt', 'latin.txt', 'shared.txt', 'user-script.mjs'],
    };
    return { projectDir, runBase, baseline };
  }

  it('leaves out the files the run did not change, and diffs the rest from the run start', async () => {
    const { projectDir, runBase, baseline } = await dirtyRun();
    writeFileSync(join(projectDir, 'shared.txt'), 'USER_LINE\nRUN_LINE\n');
    writeFileSync(join(projectDir, 'run.txt'), 'RUN_FILE\n');
    rmSync(join(projectDir, 'user-script.mjs'));

    const universe = await resolveRunUniverse({ workspaceDir: projectDir, baseline, runBase });

    expect(universe.changedFiles).toEqual(['run.txt', 'shared.txt', 'user-script.mjs']);
    expect(universe.preRunFiles).toEqual([
      'init.txt',
      'latin.txt',
      'shared.txt',
      'user-script.mjs',
    ]);
    expect(universe.fullDiff).toContain('+RUN_FILE');
    expect(universe.fullDiff).toContain('+RUN_LINE');
    expect(universe.fullDiff).toContain('-USER_SCRIPT');
    expect(universe.fullDiff).not.toContain('+USER_LINE');
    expect(universe.fullDiff).not.toContain('USER_EDIT');
    expect(universe.fullDiff).toContain('deleted file mode 100755');
  });

  it('diffs a pre-run file from its base bytes, never from a UTF-8 reading of them', async () => {
    const { projectDir, runBase, baseline } = await dirtyRun();
    writeFileSync(join(projectDir, 'latin.txt'), Buffer.from('caf\xe9\nRUN\n', 'latin1'));

    const universe = await resolveRunUniverse({ workspaceDir: projectDir, baseline, runBase });

    expect(universe.changedFiles).toEqual(['latin.txt']);
    expect(universe.fullDiff).toContain('+RUN');
    expect(universe.fullDiff).not.toContain('-caf');
  });

  it('refuses to guess when the run recorded no run base for its pre-run files', async () => {
    const { projectDir, baseline } = await dirtyRun();
    await expect(
      resolveRunUniverse({ workspaceDir: projectDir, baseline, runBase: undefined }),
    ).rejects.toThrow('no run base to compare them with');
  });
});

function writeReview(projectDir: string, sessionId: string, body: string): void {
  const dir = sessionDir(projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, REVIEW_FILE),
    `---
generated_by: splitbrief v0.0.0
---

${body}`,
  );
}

describe('buildFinalReview', () => {
  it.each(['pass', 'unverified'] as const)(
    'counts effective criterion and finding verification: %s',
    async (status) => {
      const ref = setupProject(dirs);
      writeReview(ref.projectDir, ref.sessionId, '### Verdict\nfail');
      writeSpecFile(
        ref,
        'review.json',
        JSON.stringify({
          cycle: 0,
          at: '2026-01-01T00:00:00Z',
          outcome: 'fail',
          verdict: {
            tasks: [],
            criteria: [{ id: 'C1', status: 'unverified', evidence: 'Recorded check' }],
            findings: [
              {
                id: 'F1',
                kind: 'unverified',
                severity: 'blocking',
                taskId: null,
                file: null,
                line: null,
                text: 'Proof needed',
                acceptance: null,
                checkIds: ['K1'],
                criterionId: null,
              },
            ],
          },
          verification: [
            { id: 'criterion:C1', status: 'pass', output: 'Recorded check' },
            { id: 'finding:F1', status, output: 'Recorded check' },
          ],
        }),
      );
      const section = await buildFinalReview({
        ...ref,
        requestedStatus: 'written',
        ledger: null,
        missing: [],
      });
      expect(section.criteriaPassed).toBe(1);
      expect(section.criteriaFailed).toBe(0);
      expect(section.verdict).toBe(status === 'pass' ? 'pass_with_notes' : 'fail');
      expect(section.findingCounts).toEqual({
        critical: status === 'pass' ? 0 : 1,
        warning: status === 'pass' ? 1 : 0,
        note: 0,
      });
    },
  );

  it('reports corrupt typed review data instead of using old Markdown', async () => {
    const ref = setupProject(dirs);
    writeReview(ref.projectDir, ref.sessionId, '### Verdict\npass');
    writeSpecFile(ref, 'review.json', '{}');
    await expect(
      buildFinalReview({ ...ref, requestedStatus: 'written', ledger: null, missing: [] }),
    ).rejects.toThrow('Invalid typed review');
  });

  it('reads no verdict from a run that saved only review.md, but keeps its excerpt', async () => {
    const { projectDir } = makeProject();
    const sessionId = 'review-markdown-only-session';
    writeReview(
      projectDir,
      sessionId,
      `### Verdict
fail

### Findings
- **Critical**: Unauthenticated requests return 500 instead of 401
`,
    );

    const missing: string[] = [];
    const section = await buildFinalReview({
      projectDir,
      sessionId,
      requestedStatus: 'written',
      ledger: null,
      missing,
    });

    expect(section.verdict).toBeNull();
    expect(section.findingCounts).toEqual({ critical: 0, warning: 0, note: 0 });
    expect(section.excerpt).toContain('Unauthenticated requests return 500');
    expect(section.statusText).toBe('Reviewer final review written to review.md.');
    expect(missing).not.toContain(REVIEW_FILE);
  });

  it('reads the typed review record when review.json exists, never the markdown beside it', async () => {
    const { projectDir } = makeProject();
    const sessionId = 'review-json-session';
    writeReview(
      projectDir,
      sessionId,
      `### Verdict
pass

### Findings
- **Warning**: the markdown is stale
`,
    );
    writeFileSync(
      join(sessionDir(projectDir, sessionId), REVIEW_JSON_FILE),
      JSON.stringify({
        cycle: 1,
        verdict: {
          tasks: [{ id: 'T001', plan: 'met', note: '' }],
          criteria: [
            { id: 'C1', status: 'pass', evidence: 'the recorded run shows it' },
            { id: 'C2', status: 'unverified', evidence: '' },
          ],
          findings: [
            {
              id: 'F1',
              kind: 'defect',
              severity: 'blocking',
              taskId: 'T001',
              file: null,
              line: null,
              text: 'drops the error',
              acceptance: null,
              checkIds: null,
              criterionId: null,
            },
          ],
        },
        outcome: 'fail',
        verification: [
          {
            id: 'criterion:C2',
            status: 'unverified',
            output: 'K2: not-runnable — render checks are not runnable',
          },
        ],
        at: '2026-01-01T00:00:00.000Z',
      }),
    );

    const section = await buildFinalReview({
      projectDir,
      sessionId,
      requestedStatus: 'written',
      ledger: null,
      missing: [],
    });

    expect(section.verdict).toBe('fail');
    expect(section.criteriaPassed).toBe(1);
    expect(section.criteriaFailed).toBe(1);
    expect(section.findingCounts).toEqual({ critical: 1, warning: 0, note: 0 });
  });

  it('yields the defaults when the review file is absent', async () => {
    const { projectDir } = makeProject();
    const missing: string[] = [];
    const section = await buildFinalReview({
      projectDir,
      sessionId: 'review-absent-session',
      requestedStatus: 'written',
      ledger: null,
      missing,
    });

    expect(section.verdict).toBeNull();
    expect(section.findingCounts).toEqual({ critical: 0, warning: 0, note: 0 });
    expect(section.criteriaPassed).toBe(0);
    expect(section.criteriaFailed).toBe(0);
    expect(section.excerpt).toBeNull();
    expect(missing).toContain(REVIEW_FILE);
  });

  it('names the reviewer when the final review failed', async () => {
    const { projectDir } = makeProject();
    const section = await buildFinalReview({
      projectDir,
      sessionId: 'review-failed-session',
      requestedStatus: 'failed',
      ledger: null,
      missing: [],
    });

    expect(section.status).toBe('failed');
    expect(section.statusText).toBe('Reviewer final review failed; review.md may be absent.');
  });
});

function packetWithFinalReview(finalReview: ReviewPacket['finalReview']): ReviewPacket {
  return makeReviewPacket({ finalReview });
}

describe('renderReviewPacketMarkdown final review block', () => {
  it('renders a verdict line with the finding counts', () => {
    const rendered = renderReviewPacketMarkdown(
      packetWithFinalReview({
        path: 'review.md',
        status: 'written',
        evidenceStatus: null,
        statusText: 'Reviewer final review written to review.md.',
        excerpt: null,
        verdict: 'fail',
        criteriaPassed: 2,
        criteriaFailed: 1,
        findingCounts: { critical: 1, warning: 0, note: 0 },
      }),
      NULL_CACHE,
    );

    expect(rendered).toContain('- Verdict: fail');
    expect(rendered).toContain('- Criteria: 2 passed, 1 failed');
    expect(rendered).toContain('- Findings: 1 blocking, 0 notes');
  });

  it('renders a null verdict as unknown, never as pass', () => {
    const rendered = renderReviewPacketMarkdown(
      packetWithFinalReview({
        path: 'review.md',
        status: 'missing',
        evidenceStatus: null,
        statusText: 'review.md was not available.',
        excerpt: null,
        verdict: null,
        criteriaPassed: 0,
        criteriaFailed: 0,
        findingCounts: { critical: 0, warning: 0, note: 0 },
      }),
      NULL_CACHE,
    );

    expect(rendered).toContain('- Verdict: unknown');
    expect(rendered).not.toContain('- Verdict: pass');
  });
});
