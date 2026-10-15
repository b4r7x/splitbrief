import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { sessionDir } from '../../../src/core/paths.js';
import { readReviewChanges } from '../../../src/core/evidence/review-changes.js';
import { ReviewPacketSchema } from '../../../src/core/schemas/review-packet.js';
import { WorkflowStateSchema } from '../../../src/core/schemas/workflow.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { checkoutEntries } from '#testing/helpers/checkout.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import { cli } from '../helpers/stop-continue-fixture.js';

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) cleanupTempDir(tmpDir);
  tmpDir = undefined;
});

/** Every path the brief changes: a mode, a new link, a committed link retargeted, a dirty link removed and an edit. */
const CHANGED = ['script.sh', 'note.txt', 'dirty-link', 'link', 'new-link'];

describe('e2e: saved run patch', () => {
  it.each(['staged-copy', 'worktree'] as const)(
    'replays file contents, executable modes and symlink targets onto a clean base copy (%s)',
    async (isolation) => {
      tmpDir = createTempDir('run-patch-round-trip');
      const projectDir = join(tmpDir, 'project');
      const stateHome = join(tmpDir, 'state');
      const replayDir = join(tmpDir, 'replay');
      const plan = makePlanProposal({
        summary: 'Update the script permissions and project links',
        tasks: [
          makeTaskSpec({
            title: 'Update the script permissions and project links',
            intent:
              'Make the script executable, add a link, retarget the existing link and update the note.',
            suggestedFiles: ['script.sh', 'note.txt'],
            checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
          }),
        ],
      });
      const review = passingVerdict({
        kind: 'final',
        taskIds: plan.tasks.map((task) => task.id),
        criterionIds: plan.criteria.map((criterion) => criterion.id),
      });
      createTestGitRepo(projectDir, {
        'script.sh': 'echo hello\n',
        'note.txt': 'before\n',
        'tools/planner.mjs': `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
process.stdout.write(JSON.stringify(prompt.includes('# Final Implementation Review')
  ? ${JSON.stringify(review)} : ${JSON.stringify({ result: plan })}));
`,
        'tools/implementer.mjs': `
import { chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
chmodSync('script.sh', 0o755);
symlinkSync('note.txt', 'new-link');
rmSync('link');
symlinkSync('script.sh', 'link');
rmSync('dirty-link');
writeFileSync('note.txt', 'after\\n');
`,
      });
      chmodSync(join(projectDir, 'script.sh'), 0o644);
      symlinkSync('note.txt', join(projectDir, 'link'));
      execFileSync('git', ['add', 'link'], { cwd: projectDir });
      execFileSync('git', ['commit', '-q', '-m', 'link'], { cwd: projectDir });
      symlinkSync('note.txt', join(projectDir, 'dirty-link'));
      mkdirSync(join(projectDir, '.splitbrief'));
      mkdirSync(stateHome);
      const config = makeConfig({
        planner: {
          kind: 'shell',
          command: 'node',
          args: ['./tools/planner.mjs'],
          outputFormat: 'text',
        },
        implementer: {
          kind: 'agent',
          command: 'node',
          args: ['./tools/implementer.mjs'],
          outputFormat: 'text',
          model: 'fixture',
          contextLength: 200_000,
        },
        workflow: { approve: 'none', isolation },
        validation: { endChecks: false },
      });
      writeFileSync(join(projectDir, '.splitbrief', 'config.yaml'), YAML.stringify(config));
      cpSync(projectDir, replayDir, { recursive: true, verbatimSymlinks: true });
      const base = checkoutEntries(projectDir);
      const target = { projectDir, stateHome };

      const run = await cli(target, ['start', 'Update the script permissions and project links'], {
        timeoutMs: 90_000,
      });
      expect(run.exitCode, run.stderr).toBe(0);
      const sessionId = readActive(projectDir);
      if (sessionId === null) throw new Error('the run has no active session');
      const state = WorkflowStateSchema.parse(
        JSON.parse(readFileSync(join(sessionDir(projectDir, sessionId), 'state.json'), 'utf8')),
      );
      expect(deriveRunStatus({ state, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
      const workspace = state.workspace;
      if (workspace === undefined) throw new Error('the run has no workspace');
      // The worktree's .gitignore holds isolation bookkeeping, which the patch leaves out.
      const result = Object.fromEntries(
        Object.entries(checkoutEntries(workspace.path)).filter(([path]) => path !== '.gitignore'),
      );
      expect(result['script.sh']).toBe(`493:${Buffer.from('echo hello\n').toString('base64')}`);
      expect(result['new-link']).toBe('link:note.txt');
      expect(result.link).toBe('link:script.sh');
      expect(result['note.txt']).toBe(`420:${Buffer.from('after\n').toString('base64')}`);
      expect(result['dirty-link']).toBeUndefined();
      expect(checkoutEntries(projectDir)).toEqual(base);

      const ref = { projectDir, sessionId };
      const { events } = await readRunEvents(ref);
      const done = events.find((event) => event.type === 'implementer_generate_done');
      expect(done?.type === 'implementer_generate_done' && [...(done.files ?? [])].sort()).toEqual(
        [...CHANGED].sort(),
      );
      const changes = readReviewChanges(ref)?.changes ?? [];
      expect(changes.map((change) => [change.path, change.kind]).sort()).toEqual(
        CHANGED.map((path) => [path, 'captured']).sort(),
      );
      const packet = ReviewPacketSchema.parse(
        JSON.parse(
          readFileSync(join(sessionDir(projectDir, sessionId), 'review-packet.json'), 'utf8'),
        ),
      );
      expect(packet.changes.provenance?.promotedFiles).toEqual([...CHANGED].sort());
      const drift = JSON.parse(
        readFileSync(join(sessionDir(projectDir, sessionId), 'drift-report.json'), 'utf8'),
      ) as { changedFiles: string[] };
      expect([...drift.changedFiles].sort()).toEqual([...CHANGED].sort());

      const ended = await cli(target, ['continue', sessionId, '--action', 'end-run']);
      expect(ended.exitCode, ended.stderr).toBe(0);
      const patchPath = join(sessionDir(projectDir, sessionId), 'run.patch');
      execFileSync('git', ['apply', '--check', patchPath], { cwd: replayDir });
      execFileSync('git', ['apply', patchPath], { cwd: replayDir });

      expect(checkoutEntries(replayDir)).toEqual(result);
      expect(checkoutEntries(projectDir)).toEqual(base);
    },
  );
});
