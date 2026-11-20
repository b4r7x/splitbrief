import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { expect, it } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { createDraftDocument } from '../../../src/core/composer/document.js';
import { activeFile, SESSION_LOG_FILE, sessionDir } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { writeSessionDraft } from '../../../src/core/sessions/draft.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_EXIT_INPUT, PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const VIEWPORT = { cols: 120, rows: 40 };
const WAIT = { timeout: 20_000 };
const FEATURE = 'Add greeting formats';
const QUESTION = 'Which greeting formats should the helper accept?';
const WAITING = 'Waiting for an answer in another terminal';
const OWNER_DRAFT = 'Owner-only draft';

async function inTerminal(
  fixture: Pick<StopContinueFixture, 'tmpDir' | 'projectDir'>,
  env: Readonly<Record<string, string>>,
  command: readonly string[],
  drive: (terminal: {
    screen: () => string;
    write: (keys: string) => void;
    exit: Promise<PtyExitEvent>;
  }) => Promise<void>,
): Promise<void> {
  await runWithPtyChild(
    {
      requirement: 'required',
      argv: [
        '--import',
        join(fixture.tmpDir, 'offline.mjs'),
        'dist/cli.js',
        ...command,
        '--project',
        fixture.projectDir,
      ],
      spawnOptions: {
        name: 'xterm-256color',
        ...VIEWPORT,
        cwd: resolve(import.meta.dirname, '../../..'),
        env,
      },
    },
    async (child) => {
      const exit = Promise.withResolvers<PtyExitEvent>();
      const terminal = new XtermHeadless.Terminal({
        ...VIEWPORT,
        allowProposedApi: true,
        scrollback: 0,
        logLevel: 'off',
      });
      let output = '';
      let exited = false;
      const dataListener = child.onData((data) => {
        output += data;
        terminal.write(data);
      });
      const exitListener = child.onExit((event) => {
        exited = true;
        exit.resolve(event);
      });
      try {
        await drive({
          screen: () => {
            if (exited)
              throw new Error(`SPLITBRIEF exited before rendering the expected screen.\n${output}`);
            return Array.from(
              { length: VIEWPORT.rows },
              (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
            ).join('\n');
          },
          write: (keys) => child.write(keys),
          exit: exit.promise,
        });
      } finally {
        if (!exited) await terminatePtyProcessGroup(child, exit.promise);
        dataListener.dispose();
        exitListener.dispose();
        terminal.dispose();
      }
    },
  );
}

it('opens an old stopped run with one link per artifact and one copy of each pending brief', async () => {
  const tmpDir = createTempDir('plan-block-replay');
  const projectDir = join(tmpDir, 'project');
  const sessionId = 'visual-gate-stopped';
  const titles = ['Add validator module', 'Wire validator into the signup form'];
  try {
    execFileSync('git', ['init', '--quiet', projectDir]);
    writeConfig(projectDir, makeConfig());
    writeFileSync(
      join(tmpDir, 'offline.mjs'),
      "globalThis.fetch = async () => { throw new Error('offline'); };\n",
    );
    saveState(
      { projectDir, sessionId },
      makeWorkflowState({
        feature: 'Add email validation with tests',
        phase: 'reviewing-plan',
        tasks: titles.map((title, index) => makeTask({ id: `T00${index + 1}`, title })),
        interruptedStep: {
          step: { kind: 'gate', gate: 'plan' },
          source: 'user',
          cut: 'boundary',
          at: '2026-09-14T09:47:46.000Z',
        },
      }),
    );
    copyFileSync(
      resolve(import.meta.dirname, '../../fixtures/session-log/gate-stopped.jsonl'),
      join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE),
    );
    const env = { ...safeChildEnvironment(tmpDir), XDG_STATE_HOME: join(tmpDir, 'state') };
    await inTerminal({ tmpDir, projectDir }, env, [], async ({ screen, write }) => {
      await expect.poll(screen, WAIT).toContain('Describe your feature');
      write('/sessions');
      await expect.poll(screen, WAIT).toContain('› /sessions');
      write(PTY_SUBMIT_INPUT);
      await expect.poll(screen, WAIT).toContain('Sessions · 1');
      write(PTY_SUBMIT_INPUT);
      await expect.poll(screen, WAIT).toContain('Stopped at the plan');
      await expect.poll(screen, WAIT).toContain('tasks.md');
      const frame = screen();
      const fileRows = frame
        .split('\n')
        .filter((line) => /(?:research|spec|plan|tasks)\.md\s*$/u.test(line));
      expect(fileRows.map((row) => row.trim().replace(/\s+/gu, ' '))).toEqual(
        ['Research', 'Spec', 'Plan', 'Tasks'].map(
          (label) => `${label} .splitbrief/sessions/${sessionId}/${label.toLowerCase()}.md`,
        ),
      );
      expect(frame).not.toMatch(/\d+ lines\s*$|Project Overview|Testing Strategy/mu);
      for (const title of titles) expect(frame.split(title)).toHaveLength(2);
    });
  } finally {
    cleanupTempDir(tmpDir);
  }
});

it.each(['resume', 'continue'])(
  '%s opens a read-only view of the run owned by another terminal',
  {
    timeout: 90_000,
  },
  async (command) => {
    const fixture = createStopContinueFixture(() => '');
    const { projectDir, tmpDir } = fixture;
    const trust = useTrustHome('resume-observer');
    const env: Readonly<Record<string, string>> = {
      ...safeChildEnvironment(trust.home),
      XDG_STATE_HOME: fixture.stateHome,
    };
    const calls = join(tmpDir, 'planner-called');
    const ask = join(tmpDir, 'ask');
    const planner = join(tmpDir, 'observer-planner.mjs');
    const questions = {
      kind: 'questions',
      questions: [
        { id: 'q1', text: QUESTION, choices: ['Plain text', 'HTML'], default: 'Plain text' },
      ],
    };
    try {
      writeFileSync(
        join(tmpDir, 'offline.mjs'),
        "globalThis.fetch = async () => { throw new Error('offline'); };\n",
      );
      writeFileSync(
        planner,
        `import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
for await (const chunk of process.stdin) void chunk;
appendFileSync(${JSON.stringify(calls)}, 'called\\n');
while (!existsSync(${JSON.stringify(ask)})) await delay(25);
process.stdout.write(${JSON.stringify(JSON.stringify({ result: questions }))});
`,
      );
      const config = loadConfig(projectDir).config;
      if (config.planner.kind !== 'shell') throw new Error('Expected a shell planner.');
      const configured = { ...config, planner: { ...config.planner, args: [planner] } };
      writeConfig(projectDir, configured);
      await trustDeclaredRunners({ projectDir, config: configured, pathEnv: env.PATH ?? '' });

      await inTerminal(fixture, env, ['start', FEATURE, '--allow-repo-runners'], async (owner) => {
        await expect.poll(() => existsSync(calls), WAIT).toBe(true);
        const sessionId = readActive(projectDir);
        if (sessionId === null) throw new Error('Expected the driving process to publish its run.');
        const ref = { projectDir, sessionId };
        const directory = sessionDir(projectDir, sessionId);
        const pointer = readFileSync(activeFile(projectDir), 'utf8');
        writeSessionDraft(ref, createDraftDocument(OWNER_DRAFT));
        const draftPath = join(directory, 'draft.json');
        const draft = readFileSync(draftPath, 'utf8');

        await inTerminal(
          fixture,
          env,
          [command, command === 'resume' ? '1' : sessionId],
          async (observer) => {
            await expect.poll(observer.screen, WAIT).toContain('Viewing live');
            expect(observer.screen()).not.toContain(OWNER_DRAFT);
            writeFileSync(ask, '');
            await expect.poll(owner.screen, WAIT).toContain('Question 1 of 1');
            await expect.poll(observer.screen, WAIT).toContain(QUESTION);
            await expect.poll(observer.screen, WAIT).toContain(WAITING);
            const statePath = join(directory, 'state.json');
            const transcriptPath = join(directory, 'session.jsonl');
            const state = readFileSync(statePath, 'utf8');
            const transcript = readFileSync(transcriptPath, 'utf8');

            observer.write('/quit');
            await expect.poll(observer.screen, WAIT).toContain('/quit');
            observer.write(PTY_SUBMIT_INPUT);
            expect(await observer.exit).toMatchObject({ exitCode: 0 });
            expect(readFileSync(statePath, 'utf8')).toBe(state);
            expect(readFileSync(transcriptPath, 'utf8')).toBe(transcript);
          },
        );
        expect(readFileSync(draftPath, 'utf8')).toBe(draft);
        expect(readFileSync(activeFile(projectDir), 'utf8')).toBe(pointer);
        expect(readFileSync(calls, 'utf8')).toBe('called\n');
        expect(owner.screen()).toContain('Question 1 of 1');
        owner.write(PTY_EXIT_INPUT);
      });
    } finally {
      await reapOrphanRunners(projectDir);
      trust.restore();
      cleanupTempDir(tmpDir);
    }
  },
);
