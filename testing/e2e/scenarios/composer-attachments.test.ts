import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, describe, expect, it, type TestContext, vi } from 'vitest';
import { CONFIRM_PHRASE } from '../../../src/core/approval/types.js';
import { attachmentFailureText } from '../../../src/core/attachments/failure.js';
import { inlineRunnerCommand } from '../../../src/core/config/custom-commands/schema.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR, sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { prepareCustomRunnerAdmission } from '../../../src/engine/runners/custom/admission.js';
import { inlineRunnerSecurityPosture } from '../../../src/engine/runners/custom/posture.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { wholeFrames } from '../helpers/whole-frames.js';

let fixture: StopContinueFixture;
let promptsPath: string;
let offlinePath: string;
let environment: Readonly<Record<string, string>>;
let testContext: TestContext;

beforeEach(async (context) => {
  testContext = context;
  fixture = createStopContinueFixture(undefined, { isolation: 'none' });
  const home = join(fixture.tmpDir, 'home');
  const binDir = join(fixture.tmpDir, 'bin');
  mkdirSync(home);
  mkdirSync(binDir);
  promptsPath = join(fixture.tmpDir, 'planner-prompt.json');
  const plannerPath = join(fixture.tmpDir, 'recording-planner.mjs');
  writeFileSync(
    plannerPath,
    `import { spawnSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const recording = ${JSON.stringify(promptsPath)};
writeFileSync(recording + '.tmp', JSON.stringify(prompt));
renameSync(recording + '.tmp', recording);
const reply = spawnSync(process.execPath, [${JSON.stringify(join(fixture.projectDir, 'tools/planner.mjs'))}], {
  input: prompt,
  encoding: 'utf8',
});
if (reply.status !== 0) throw new Error(reply.stderr);
process.stdout.write(reply.stdout);
`,
  );
  const implementerPath = join(fixture.tmpDir, 'implementer.mjs');
  writeFileSync(
    implementerPath,
    "throw new Error('The composer scenario stops at the plan card');\n",
  );
  const config = loadConfig(fixture.projectDir).config;
  const planner = {
    ...config.planner,
    kind: 'shell' as const,
    command: process.execPath,
    args: [plannerPath],
  };
  const implementer = {
    ...config.implementer,
    kind: 'agent' as const,
    command: process.execPath,
    args: [implementerPath],
    model: 'fixture',
  };
  writeConfig(fixture.projectDir, {
    ...config,
    planner,
    implementer,
    workflow: { ...config.workflow, approve: 'plan' },
  });
  for (const tool of Object.values(CLI_TOOL_CATALOG)) {
    writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
  }
  const restorePath = activateSafeCliShimPath(binDir);
  try {
    environment = safeChildEnvironment(home, [binDir]);
    for (const [role, runner] of [
      ['planner', planner],
      ['implementer', implementer],
    ] as const) {
      const command = inlineRunnerCommand({ runner, role });
      const admission = await prepareCustomRunnerAdmission({
        projectDir: fixture.projectDir,
        runner: { source: 'inline', command },
        posture: inlineRunnerSecurityPosture(role, command.contract),
        phase: role === 'planner' ? 'planning' : 'implementing',
        interaction: 'interactive',
        allowRepoRunners: true,
        stateDir: join(home, SPLITBRIEF_DIR, 'trust'),
        authorizationPathEnv: environment.PATH,
        onTieredApproval: async () => ({
          decision: 'confirm',
          phrase: CONFIRM_PHRASE,
          reason: 'Local fixture runner.',
        }),
      });
      expect(admission.kind).toBe('admitted');
    }
  } finally {
    restorePath();
  }
  offlinePath = join(fixture.tmpDir, 'offline.mjs');
  writeFileSync(
    offlinePath,
    "globalThis.fetch = async () => { throw new Error('Network disabled in attachment E2E'); };\n",
  );
});

afterEach(() => {
  cleanupTempDir(fixture.tmpDir);
});

async function runComposerScenario(
  draft: string,
  observe: (visible: () => string, write: (keys: string) => void) => Promise<void>,
): Promise<void> {
  const viewport = { cols: 200, rows: 40 };
  const result = await runWithPtyChild(
    {
      requirement: process.env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
      argv: [
        '--import',
        'tsx',
        '--import',
        offlinePath,
        'src/cli.ts',
        '--allow-repo-runners',
        '--project',
        fixture.projectDir,
      ],
      spawnOptions: {
        name: 'xterm-256color',
        ...viewport,
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { ...environment, XDG_STATE_HOME: fixture.stateHome },
      },
    },
    async (child) => {
      const exited = Promise.withResolvers<PtyExitEvent>();
      let didExit = false;
      const terminal = new XtermHeadless.Terminal({ ...viewport, allowProposedApi: true });
      const screen = () => {
        const buffer = terminal.buffer.active;
        return Array.from(
          { length: viewport.rows },
          (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '',
        ).join('\n');
      };
      const frames = wholeFrames((data) => terminal.write(data));
      const exitListener = child.onExit((event) => {
        frames.flush();
        didExit = true;
        exited.resolve(event);
      });
      const dataListener = child.onData(frames.feed);
      try {
        await vi.waitFor(() => expect(screen()).toContain('Describe your feature'), {
          timeout: 20_000,
        });
        child.write(draft);
        await vi.waitFor(() => {
          const visible = screen();
          expect(visible).toContain('› smoke');
          expect(visible).toContain('@');
          expect(visible).toContain(draft.slice(draft.lastIndexOf('/') + 1));
        });
        child.write(PTY_SUBMIT_INPUT);
        await observe(screen, (keys) => child.write(keys));

        child.write('\x03');
        await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'));
        child.write('\x03');
        await vi.waitFor(() => expect(didExit).toBe(true), { timeout: 3_000 });
        expect(await exited.promise).toMatchObject({ exitCode: 0 });
      } finally {
        try {
          await terminatePtyProcessGroup(child, exited.promise);
        } finally {
          dataListener.dispose();
          exitListener.dispose();
          terminal.dispose();
        }
      }
    },
  );
  if (result) testContext.skip(result.reason);
}

describe('e2e: composer attachments', () => {
  it('keeps the draft and attachment after allocation fails and starts exactly one session on Enter', async () => {
    const sessions = sessionsRoot(fixture.projectDir);
    // A dangling link leaves the session list empty but prevents mkdir on every supported OS.
    symlinkSync('missing-sessions', sessions);
    const path = join(fixture.projectDir, 'retry-notes.md');
    writeFileSync(path, 'Keep the greeting argument optional.\n');
    const draft = 'smoke @retry-notes.md for the planner';

    await runComposerScenario(draft, async (screen, write) => {
      const cause = 'Could not create the session folder';
      await vi.waitFor(() => expect(screen()).toContain(cause), { timeout: 20_000 });
      const failed = screen();
      expect(failed).toContain('/crew to change');
      expect(failed).toMatch(new RegExp(`✗ ${cause} +[│▐]\\n`));
      expect(failed).toMatch(/→ Check the folder/u);
      expect(failed).toContain('⏎ try again · ctrl+d details');
      const input = failed.slice(failed.indexOf(cause));
      expect(input).toContain(`› ${draft}`);
      expect(readActive(fixture.projectDir)).toBeNull();
      expect(existsSync(sessions)).toBe(false);
      expect(existsSync(promptsPath)).toBe(false);

      unlinkSync(sessions);
      write(PTY_SUBMIT_INPUT);
      await vi.waitFor(() => expect(screen()).toContain('Approve plan and start the build'), {
        timeout: 20_000,
      });
      const sessionId = readActive(fixture.projectDir);
      if (sessionId === null) throw new Error('The retried run did not publish a session.');
      expect(readdirSync(sessions)).toEqual([sessionId]);
      const replay = await readRunEvents({ projectDir: fixture.projectDir, sessionId });
      expect(replay.events.filter((event) => event.type === 'user_message')).toEqual([
        expect.objectContaining({
          text: draft,
          attachedInputs: [{ kind: 'text', path: realpathSync(path) }],
        }),
      ]);
      const prompt: string = JSON.parse(readFileSync(promptsPath, 'utf8'));
      expect(prompt).toContain('--- @retry-notes.md ---\nKeep the greeting argument optional.');
    });
  });

  it('sends an outside text file through the home composer to the real planner prompt', async () => {
    const path = join(fixture.tmpDir, 'outside-notes.md');
    const content = `Keep this outside attachment marker: ${fixture.tmpDir}.\n`;
    writeFileSync(path, content);

    await runComposerScenario(`smoke @${path}`, async (visible) => {
      await vi.waitFor(
        () => {
          const prompt: string = JSON.parse(readFileSync(promptsPath, 'utf8'));
          expect(prompt).toContain(`--- @${path} ---\n${content}`);
        },
        { timeout: 20_000 },
      );
      await vi.waitFor(() => expect(visible()).toContain('Approve plan and start the build'), {
        timeout: 20_000,
      });
      await vi.waitFor(async () => {
        const sessionId = readActive(fixture.projectDir);
        if (sessionId === null) throw new Error('The plan card has no active session');
        const replay = await readRunEvents({ projectDir: fixture.projectDir, sessionId });
        expect(replay.events.find((event) => event.type === 'user_message')).toMatchObject({
          attachedInputs: [{ kind: 'text', path: realpathSync(path) }],
        });
      });
    });
  });

  it.each([
    { name: 'directory', reason: 'not-a-file' },
    { name: 'unreadable.md', reason: 'unreadable' },
  ] as const)('refuses an outside $name and keeps the composer draft', async ({ name, reason }) => {
    const path = join(fixture.tmpDir, name);
    if (reason === 'not-a-file') mkdirSync(path);
    else {
      writeFileSync(path, 'This file must not reach the planner.\n');
      chmodSync(path, 0o000);
    }
    try {
      await runComposerScenario(`smoke @${path}`, async (visible) => {
        await vi.waitFor(() => {
          const screen = visible();
          expect(screen).toContain(`Cannot send: ${attachmentFailureText(reason)} File: ${name}.`);
          const composer = screen.slice(screen.lastIndexOf('› smoke'));
          expect(composer).toContain('› smoke');
          expect(composer).toContain('@/');
          expect(composer).toContain(name);
        });
        expect(existsSync(promptsPath)).toBe(false);
        expect(existsSync(sessionsRoot(fixture.projectDir))).toBe(false);
      });
    } finally {
      if (reason === 'unreadable') chmodSync(path, 0o600);
    }
  });
});
