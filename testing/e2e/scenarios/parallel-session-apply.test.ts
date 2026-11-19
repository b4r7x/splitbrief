import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { readRunRecord } from '../../../src/core/sessions/run/record-io.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { passingVerdict } from '#testing/helpers/typed-planner.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import { forwardTerminalReplies } from '../helpers/terminal-replies.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const VIEWPORT = { cols: 120, rows: 40 };
const PATIENCE = { timeout: 40_000 };
const FIRST_FILE = 'first.txt';
const FIRST_HEAD = 'first file at HEAD\n';
const FIRST_EDIT = 'private edit from the checkout run\n';
const SECOND_FILE = 'second.txt';
const SECOND_HEAD = 'second file at HEAD\n';
const SECOND_EDIT = 'edit from the isolated run\n';

function planReply(file: string): string {
  const task = makeTaskSpec({
    title: `Update ${file}`,
    intent: `Replace the text in ${file}.`,
    suggestedFiles: [file],
    checks: [{ id: 'K1', kind: 'test', value: file }],
  });
  return JSON.stringify({
    result: makePlanProposal({
      summary: task.title,
      decisions: [],
      criteria: [{ id: 'C1', text: task.intent, checkIds: ['K1'] }],
      tasks: [task],
    }),
  });
}

function replayRunner({
  reviewStarted,
  release,
  plannerView,
}: {
  reviewStarted: string;
  release: string;
  plannerView: string;
}): string {
  const review = JSON.stringify(
    passingVerdict({ kind: 'final', taskIds: ['T001'], criterionIds: ['C1'] }),
  );
  return `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const [role, file] = process.argv.slice(2);
const first = file === ${JSON.stringify(FIRST_FILE)};
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');

if (role === 'build') {
  writeFileSync(file, first ? ${JSON.stringify(FIRST_EDIT)} : ${JSON.stringify(SECOND_EDIT)});
  console.log('Updated ' + file);
} else if (prompt.includes('# Final Implementation Review')) {
  if (first) {
    writeFileSync(${JSON.stringify(reviewStarted)}, '');
    while (!existsSync(${JSON.stringify(release)})) await delay(25);
  }
  process.stdout.write(${JSON.stringify(review)});
} else {
  if (!first) {
    writeFileSync(${JSON.stringify(plannerView)}, JSON.stringify({
      firstFile: readFileSync(${JSON.stringify(FIRST_FILE)}, 'utf8'),
      privateEditInPrompt: prompt.includes(${JSON.stringify(FIRST_EDIT.trim())}),
    }));
  }
  process.stdout.write(first ? ${JSON.stringify(planReply(FIRST_FILE))} : ${JSON.stringify(planReply(SECOND_FILE))});
}
`;
}

function runConfig(script: string, file: string, isolation?: 'none') {
  return makeConfig({
    planner: {
      kind: 'shell',
      command: process.execPath,
      args: [script, 'plan', file],
      outputFormat: 'text',
      capabilities: { supportsConversationalPlanning: false, supportsSessionResume: false },
    },
    implementer: {
      kind: 'agent',
      command: process.execPath,
      args: [script, 'build', file],
      outputFormat: 'text',
      model: 'fixture',
      contextLength: 200_000,
    },
    workflow: { approve: 'none', ...(isolation === undefined ? {} : { isolation }) },
    validation: { endChecks: false, testCommand: 'node --version' },
  });
}

it('starts and applies an isolated run while a checkout run is reviewing', async () => {
  const tmpDir = createTempDir('parallel-session-apply');
  const home = useTrustHome('parallel-session-home');
  const projectDir = join(tmpDir, 'project');
  const stateHome = join(tmpDir, 'state');
  const reviewStarted = join(tmpDir, 'checkout-review-started');
  const release = join(tmpDir, 'release-checkout-review');
  const plannerView = join(tmpDir, 'isolated-planner-view.json');
  const script = join(tmpDir, 'runner.mjs');
  const offline = join(tmpDir, 'offline.mjs');
  const abortCheckout = new AbortController();
  let checkout: ReturnType<typeof spawnCli> | undefined;
  let checkoutExited = false;

  try {
    createTestGitRepo(projectDir, { [FIRST_FILE]: FIRST_HEAD, [SECOND_FILE]: SECOND_HEAD });
    writeFileSync(script, replayRunner({ reviewStarted, release, plannerView }));
    writeFileSync(offline, "globalThis.fetch = async () => { throw new Error('offline'); };\n");
    writeConfig(projectDir, runConfig(script, FIRST_FILE, 'none'));
    checkout = spawnCli({
      args: [
        '--import',
        offline,
        'dist/cli.js',
        'start',
        `Update ${FIRST_FILE}`,
        '--plain',
        '--allow-repo-runners',
        '--project',
        projectDir,
      ],
      stateHome,
      timeoutMs: 110_000,
      signal: abortCheckout.signal,
      reapProjectDir: projectDir,
    }).then((result) => {
      checkoutExited = true;
      return result;
    });

    await vi.waitFor(() => {
      expect(checkoutExited).toBe(false);
      expect(existsSync(reviewStarted)).toBe(true);
    }, PATIENCE);
    const [checkoutId] = readdirSync(sessionsRoot(projectDir));
    if (checkoutId === undefined) throw new Error('Checkout review started without a session');
    const checkoutRef = { projectDir, sessionId: checkoutId };
    expect(loadState(checkoutRef)?.workspace?.kind).toBe('checkout');
    expect(readFileSync(join(projectDir, FIRST_FILE), 'utf8')).toBe(FIRST_EDIT);

    const config = runConfig(script, SECOND_FILE);
    writeConfig(projectDir, config);
    const env: Readonly<Record<string, string>> = {
      ...safeChildEnvironment(home.home),
      XDG_STATE_HOME: stateHome,
    };
    await trustDeclaredRunners({ projectDir, config, pathEnv: env.PATH ?? '' });

    await runWithPtyChild(
      {
        requirement: 'required',
        argv: [
          '--import',
          offline,
          'dist/cli.js',
          'start',
          `Update ${SECOND_FILE}`,
          '--allow-repo-runners',
          '--project',
          projectDir,
        ],
        spawnOptions: { name: 'xterm-256color', ...VIEWPORT, cwd: REPO_ROOT, env },
      },
      async (child) => {
        const terminal = new XtermHeadless.Terminal({
          ...VIEWPORT,
          allowProposedApi: true,
          logLevel: 'off',
        });
        const exited = Promise.withResolvers<PtyExitEvent>();
        let exit: PtyExitEvent | undefined;
        let output = '';
        const screen = () =>
          Array.from(
            { length: VIEWPORT.rows },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          ).join('\n');
        const dataListener = child.onData((chunk) => {
          output += chunk;
          terminal.write(chunk);
        });
        const replyListener = forwardTerminalReplies(terminal, child);
        const exitListener = child.onExit((event) => {
          exit = event;
          exited.resolve(event);
        });
        try {
          await vi.waitFor(() => {
            if (exit === undefined) expect(screen()).toContain('▌ Apply');
          }, PATIENCE);
          expect(exit, output).toBeUndefined();

          expect(JSON.parse(readFileSync(plannerView, 'utf8'))).toEqual({
            firstFile: FIRST_HEAD,
            privateEditInPrompt: false,
          });
          const sessionIds = readdirSync(sessionsRoot(projectDir)).filter(
            (id) => id !== checkoutId,
          );
          expect(sessionIds).toHaveLength(1);
          const [sessionId] = sessionIds;
          if (sessionId === undefined)
            throw new Error('Isolated review finished without a session');
          const ref = { projectDir, sessionId };
          expect(loadState(ref)?.workspace?.kind).toBe('worktree');
          expect(readFileSync(join(projectDir, SECOND_FILE), 'utf8')).toBe(SECOND_HEAD);

          child.write(PTY_SUBMIT_INPUT);
          await expect.poll(screen, PATIENCE).toContain('Applied');
          expect(loadState(ref)?.closed?.as).toBe('applied');
          expect(readFileSync(join(projectDir, SECOND_FILE), 'utf8')).toBe(SECOND_EDIT);
          expect(readFileSync(join(projectDir, FIRST_FILE), 'utf8')).toBe(FIRST_EDIT);
          expect(checkoutExited).toBe(false);
          expect(readRunRecord(checkoutRef, false).status).toEqual({ kind: 'running' });
        } finally {
          if (exit === undefined) await terminatePtyProcessGroup(child, exited.promise);
          dataListener.dispose();
          replyListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      },
    );

    writeFileSync(release, '');
    const outcome = await checkout;
    expect(outcome.exitCode, `${outcome.stdout}\n${outcome.stderr}`).toBe(0);
    expect(
      readRunRecord(checkoutRef, false).status,
      `${outcome.stdout}\n${outcome.stderr}`,
    ).toEqual({
      kind: 'closed',
      as: 'complete',
    });
    expect(readFileSync(join(projectDir, FIRST_FILE), 'utf8')).toBe(FIRST_EDIT);
    expect(readFileSync(join(projectDir, SECOND_FILE), 'utf8')).toBe(SECOND_EDIT);
  } finally {
    abortCheckout.abort();
    await checkout;
    await reapOrphanRunners(projectDir);
    home.restore();
    cleanupTempDir(tmpDir);
  }
});
