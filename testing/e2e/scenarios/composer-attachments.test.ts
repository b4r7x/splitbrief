import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, type TestContext, vi } from 'vitest';
import { CONFIRM_PHRASE } from '../../../src/core/approval/types.js';
import { attachmentFailureText } from '../../../src/core/attachments/failure.js';
import { inlineRunnerCommand } from '../../../src/core/config/custom-commands.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR, sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { prepareCustomRunnerAdmission } from '../../../src/engine/runners/custom-admission.js';
import { inlineRunnerSecurityPosture } from '../../../src/engine/runners/custom-trust.js';
import { stripTerminalControls } from '../../../src/utils/display-text.js';
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
  observe: (visible: () => string) => Promise<void>,
): Promise<void> {
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
        cols: 200,
        rows: 40,
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        env: { ...environment, XDG_STATE_HOME: fixture.stateHome },
      },
    },
    async (child) => {
      const exited = Promise.withResolvers<PtyExitEvent>();
      let didExit = false;
      let rawIo = '';
      const exitListener = child.onExit((event) => {
        didExit = true;
        exited.resolve(event);
      });
      const dataListener = child.onData((data) => {
        rawIo += data;
      });
      try {
        await vi.waitFor(
          () => expect(stripTerminalControls(rawIo)).toContain('Describe your feature'),
          { timeout: 20_000 },
        );
        child.write(draft);
        await vi.waitFor(() => {
          const screen = stripTerminalControls(rawIo);
          expect(screen).toContain('› smoke');
          expect(screen).toContain('@/');
          expect(screen).toContain(draft.slice(draft.lastIndexOf('/') + 1));
        });
        const submittedAt = rawIo.length;
        child.write(PTY_SUBMIT_INPUT);
        await observe(() => stripTerminalControls(rawIo.slice(submittedAt)));

        const quitAt = rawIo.length;
        child.write('\x03');
        await vi.waitFor(() =>
          expect(stripTerminalControls(rawIo.slice(quitAt))).toContain(
            'Press ctrl+c again to quit',
          ),
        );
        child.write('\x03');
        await vi.waitFor(() => expect(didExit).toBe(true), { timeout: 3_000 });
        expect(await exited.promise).toMatchObject({ exitCode: 0 });
      } finally {
        try {
          await terminatePtyProcessGroup(child, exited.promise);
        } finally {
          dataListener.dispose();
          exitListener.dispose();
        }
      }
    },
  );
  if (result) testContext.skip(result.reason);
}

describe('e2e: composer attachments', () => {
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
