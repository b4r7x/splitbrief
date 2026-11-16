import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, type TestContext, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent, PtyProcess } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  PLAN_ANSWER,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const VIEWPORT = { cols: 160, rows: 40 };
/** The typed plan with a task that reads a file of the project, which no task writes. */
const CONTEXT_PLAN = JSON.stringify({
  result: {
    ...PLAN_ANSWER.result,
    tasks: PLAN_ANSWER.result.tasks.map((task) => ({
      ...task,
      contextFiles: ['tools/planner.mjs'],
    })),
  },
});
let fixture: StopContinueFixture;
let environment: Readonly<Record<string, string>>;
let offlinePath: string;

beforeEach(async () => {
  fixture = createStopContinueFixture(
    () => "throw new Error('BUILD must not start in the plan editor E2E');\n",
    // The build never starts, so the plan call is the one planner call.
    { isolation: 'none', consult: () => `() => ${JSON.stringify(CONTEXT_PLAN)}` },
  );
  const home = join(fixture.tmpDir, 'home');
  const bin = join(fixture.tmpDir, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  for (const tool of Object.values(CLI_TOOL_CATALOG)) {
    writeFakeNodeCli(bin, tool.command, 'process.exit(1);');
  }
  environment = safeChildEnvironment(home, [bin]);
  const initial = loadConfig(fixture.projectDir).config;
  const config = {
    ...initial,
    planner: { ...initial.planner, command: process.execPath },
    implementer: { ...initial.implementer, command: process.execPath },
    workflow: { ...initial.workflow, approve: 'plan' as const },
  };
  writeConfig(fixture.projectDir, config);
  await trustDeclaredRunners({
    projectDir: fixture.projectDir,
    config,
    pathEnv: environment.PATH ?? '',
    stateDir: join(home, SPLITBRIEF_DIR, 'trust'),
  });
  offlinePath = join(fixture.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('Network disabled in plan editor E2E'); };\n",
  );
});

afterEach(() => cleanupTempDir(fixture.tmpDir));

interface PlanEditorPty {
  readonly child: PtyProcess;
  readonly screen: () => string;
  readonly didExit: () => boolean;
  readonly exited: Promise<PtyExitEvent>;
}

/** Starts a run in a terminal, opens the plan.json editor at the plan card, then takes the steps. */
async function atPlanEditor(
  context: TestContext,
  viewport: { cols: number; rows: number },
  steps: (pty: PlanEditorPty) => Promise<void>,
) {
  const result = await runWithPtyChild(
    {
      requirement: process.env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
      argv: [
        '--import',
        'tsx',
        '--import',
        offlinePath,
        'src/cli.ts',
        'start',
        'smoke',
        '--allow-repo-runners',
        '--project',
        fixture.projectDir,
      ],
      spawnOptions: {
        name: 'xterm-256color',
        ...viewport,
        cwd: REPO_ROOT,
        env: { ...environment, XDG_STATE_HOME: fixture.stateHome },
      },
    },
    async (child) => {
      const terminal = new XtermHeadless.Terminal({
        ...viewport,
        allowProposedApi: true,
        logLevel: 'off',
      });
      const exited = Promise.withResolvers<PtyExitEvent>();
      let didExit = false;
      const screen = () =>
        Array.from(
          { length: viewport.rows },
          (_, row) =>
            terminal.buffer.active
              .getLine(terminal.buffer.active.viewportY + row)
              ?.translateToString(true) ?? '',
        ).join('\n');
      const dataListener = child.onData((data) => terminal.write(data));
      const exitListener = child.onExit((event) => {
        didExit = true;
        exited.resolve(event);
      });
      try {
        await vi.waitFor(() => expect(screen()).toContain('Approve plan and start the build'), {
          timeout: 30_000,
        });
        child.write('e');
        await vi.waitFor(() => expect(screen()).toContain('› e'));
        child.write(PTY_SUBMIT_INPUT);
        await vi.waitFor(() => expect(screen()).toContain('"summary"'), { timeout: 10_000 });
        await steps({ child, screen, didExit: () => didExit, exited: exited.promise });
      } finally {
        try {
          if (!didExit) await terminatePtyProcessGroup(child, exited.promise);
        } finally {
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      }
    },
  );
  if (result) context.skip(result.reason);
}

it('deletes the character before the caret on Backspace in the plan.json editor', async (context) => {
  await atPlanEditor(context, VIEWPORT, async ({ child, screen, didExit, exited }) => {
    const firstEditorLine = () => screen().match(/^│ (\S*\{)\s*│$/m)?.[1];
    child.write('AB');
    await vi.waitFor(() => expect(firstEditorLine()).toBe('AB{'));
    child.write('\x1b[D');
    child.write('\x7f');
    await vi.waitFor(() => expect(firstEditorLine(), screen()).toBe('B{'));

    child.write('\x1b');
    await vi.waitFor(() => expect(screen()).toContain('Approve plan and start the build'));
    child.write('\x03');
    await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'));
    child.write('\x03');
    await vi.waitFor(() => expect(didExit()).toBe(true), { timeout: 5_000 });
    expect(await exited).toMatchObject({ exitCode: 0 });
  });
});

it('scrolls the plan.json editor one row on the first wheel-up step after Backspace takes the last line away', async (context) => {
  await atPlanEditor(context, { cols: 80, rows: 24 }, async ({ child, screen }) => {
    const bufferRows = () => {
      const rows = screen().split('\n');
      const top = rows.findIndex((row) => /^│ ─+ │$/u.test(row));
      const legend = rows.findIndex((row) => row.includes('ctrl+s save'));
      return rows
        .slice(top + 1, legend)
        .map((row) => row.replace(/^│ ?/u, '').replace(/│$/u, '').trimEnd());
    };
    child.write('\x1b[1;5F');
    // plan.json ends with a line break, so the caret is on the empty last line.
    await vi.waitFor(() => expect(bufferRows().slice(-2), screen()).toEqual(['}', '']));
    const atEnd = bufferRows();

    child.write('\x7f');
    await vi.waitFor(() => expect(bufferRows().slice(1), screen()).toEqual(atEnd.slice(0, -1)));
    const afterDelete = bufferRows();

    child.write('\u001b[<64;40;12M');
    await vi.waitFor(
      () => expect(bufferRows().slice(1), screen()).toEqual(afterDelete.slice(0, -1)),
      { timeout: 5_000 },
    );
  });
});

it.for([
  ['Ctrl+S', '\x13'],
  ['Ctrl+O', '\x0f'],
] as const)(
  'keeps the plan.json editor open and says that the project folder is gone on %s after the folder moved',
  async ([, key], context) => {
    await atPlanEditor(context, { cols: 80, rows: 24 }, async ({ child, screen, didExit }) => {
      const movedDir = join(fixture.tmpDir, 'moved-project');
      renameSync(fixture.projectDir, movedDir);
      // The screen without borders and spaces, so a wrapped path reads as one.
      const frameText = () => screen().replace(/[│|\s]/gu, '');

      child.write(key);

      await vi.waitFor(
        () => expect(frameText().includes('/projectisgone') || didExit(), screen()).toBe(true),
        { timeout: 10_000 },
      );
      expect(didExit(), screen()).toBe(false);
      expect(frameText()).toContain('Notsaved:theprojectfolder');
      expect(screen()).toContain('ctrl+s save');
      expect(existsSync(fixture.projectDir)).toBe(false);
    });
  },
);
