import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { afterEach, beforeEach, expect, it, type TestContext, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent, PtyProcess } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  createStopContinueFixture,
  endImplementerHold,
  findMarker,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { wholeFrames } from '../helpers/whole-frames.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const VIEWPORT = { cols: 160, rows: 40 };
const WORDS = 'keep the parser';
const TRUST_GATE = 'Trust and run a configured runner';
let fixture: StopContinueFixture;
let environment: Readonly<Record<string, string>>;
let offlinePath: string;
let home = '';
/** While this file exists and the release file does not, `opencode auth list` does not answer. */
let authHoldPath = '';
let authReleasePath = '';
let authWaitingPath = '';

beforeEach(async () => {
  fixture = createStopContinueFixture();
  home = join(fixture.tmpDir, 'home');
  const bin = join(fixture.tmpDir, 'bin');
  authHoldPath = join(fixture.tmpDir, 'auth-hold');
  authReleasePath = join(fixture.tmpDir, 'auth-release');
  authWaitingPath = join(fixture.tmpDir, 'auth-waiting');
  mkdirSync(home);
  mkdirSync(bin);
  for (const tool of Object.values(CLI_TOOL_CATALOG)) {
    writeFakeNodeCli(bin, tool.command, 'process.exit(1);');
  }
  const opencodeData = join(home, '.local', 'share', 'opencode');
  mkdirSync(opencodeData, { recursive: true });
  writeFileSync(join(opencodeData, 'auth.json'), '{"anthropic":{"type":"api"}}');
  const providers = JSON.stringify([
    { id: 'anthropic', name: 'Anthropic', connections: [{ type: 'credential' }] },
  ]);
  writeFakeNodeCli(
    bin,
    'opencode',
    `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(${JSON.stringify(CLI_TOOL_CATALOG.opencode.compatibility.testedVersion)});
  process.exit(0);
}
if (args[0] !== 'auth' || args[1] !== 'list') process.exit(1);
const answer = () => {
  console.log(${JSON.stringify(providers)});
  process.exit(0);
};
if (!fs.existsSync(${JSON.stringify(authHoldPath)}) || fs.existsSync(${JSON.stringify(authReleasePath)})) answer();
fs.writeFileSync(${JSON.stringify(authWaitingPath)}, String(process.pid));
const poll = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(authReleasePath)})) return;
  clearInterval(poll);
  answer();
}, 50);`,
  );
  environment = safeChildEnvironment(home, [bin]);
  const initial = loadConfig(fixture.projectDir).config;
  const config = {
    ...initial,
    planner: { ...initial.planner, command: process.execPath },
    implementer: { ...initial.implementer, command: process.execPath },
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
    "globalThis.fetch = async () => { throw new Error('Network disabled in trust gate E2E'); };\n",
  );
});

afterEach(async () => {
  writeFileSync(authReleasePath, '');
  if (existsSync(authWaitingPath)) {
    try {
      process.kill(Number(readFileSync(authWaitingPath, 'utf8')), 'SIGKILL');
    } catch {}
  }
  await endImplementerHold(fixture);
  cleanupTempDir(fixture.tmpDir);
});

/** The words in the composer box: the row that holds the prompt glyph, inside its border. */
function composerText(screen: string): string {
  const row = screen.split('\n').find((line) => line.includes('› ')) ?? '';
  return row.split('│')[1]?.trim() ?? '(no composer row)';
}

/**
 * Starts the run in a PTY and stops it at rest. The project config then moves the planner seat to
 * a CLI tool and the machine forgets its runner trust, so ⏎ continues through a trust gate on the
 * continuation page. The words are typed while the tools are checked, so they wait in the run's
 * composer under the page when the gate opens. Then runs `body` and quits with ctrl+c twice.
 */
async function withTrustGateOverWords(
  context: TestContext,
  body: (child: PtyProcess, screen: () => string) => Promise<void>,
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
        'start',
        'smoke',
        '--allow-repo-runners',
        '--project',
        fixture.projectDir,
      ],
      spawnOptions: {
        name: 'xterm-256color',
        ...VIEWPORT,
        cwd: REPO_ROOT,
        env: { ...environment, XDG_STATE_HOME: fixture.stateHome },
      },
    },
    async (child) => {
      const terminal = new XtermHeadless.Terminal({
        ...VIEWPORT,
        allowProposedApi: true,
        logLevel: 'off',
      });
      const exited = Promise.withResolvers<PtyExitEvent>();
      let didExit = false;
      const screen = () =>
        Array.from(
          { length: VIEWPORT.rows },
          (_, row) =>
            terminal.buffer.active
              .getLine(terminal.buffer.active.viewportY + row)
              ?.translateToString(true) ?? '',
        ).join('\n');
      const frames = wholeFrames((data) => terminal.write(data));
      const dataListener = child.onData(frames.feed);
      const exitListener = child.onExit((event) => {
        frames.flush();
        didExit = true;
        exited.resolve(event);
      });
      try {
        await vi.waitFor(
          () => expect(findMarker(fixture.isolationTreesDir), screen()).not.toBeNull(),
          { timeout: 75_000, interval: 100 },
        );
        child.write('\x1b');
        await vi.waitFor(() => expect(screen()).toContain('Stop options'), { timeout: 10_000 });
        child.write('\x1b');
        await vi.waitFor(() => expect(screen()).toContain('Back to sessions'), {
          timeout: 15_000,
        });

        writeConfig(fixture.projectDir, {
          ...loadConfig(fixture.projectDir).config,
          planner: { kind: 'cli', tool: 'opencode', model: 'anthropic/claude-sonnet-5' },
        });
        rmSync(join(home, SPLITBRIEF_DIR, 'trust'), { recursive: true, force: true });
        writeFileSync(authHoldPath, '');

        child.write('\t');
        await vi.waitFor(
          () => expect(composerText(screen())).toMatch(/^›\s+Type a correction…$/u),
          {
            timeout: 10_000,
          },
        );
        child.write('\r');
        await vi.waitFor(
          () => {
            expect(existsSync(authWaitingPath), screen()).toBe(true);
            expect(screen()).toContain('Checking tools');
          },
          { timeout: 20_000 },
        );
        child.write(WORDS);
        await vi.waitFor(() => expect(composerText(screen())).toBe(`› ${WORDS}`), {
          timeout: 10_000,
        });

        writeFileSync(authReleasePath, '');
        await vi.waitFor(() => expect(screen()).toContain(TRUST_GATE), { timeout: 20_000 });
        // The gate drops the keys of its typeahead grace, so the next key is one typed on the gate.
        await delay(PROMPT_TYPEAHEAD_GRACE_MS + 50);

        await body(child, screen);

        child.write('\x03');
        await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'), {
          timeout: 10_000,
        });
        child.write('\x03');
        await vi.waitFor(() => expect(didExit).toBe(true), { timeout: 10_000 });
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

it('x on a trust gate over typed words denies it and leaves the words in the composer', {
  timeout: 240_000,
}, async (context) => {
  await withTrustGateOverWords(context, async (child, screen) => {
    child.write('x');
    await vi.waitFor(() => expect(screen()).toContain('⏎ try again'), { timeout: 20_000 });
    child.write('rs');
    await vi.waitFor(() => expect(composerText(screen())).toBe(`› ${WORDS}rs`));
    child.write('\x1b');
    await vi.waitFor(
      () => {
        expect(screen()).not.toContain('⏎ try again');
        expect(screen()).toContain('/sessions');
      },
      { timeout: 10_000 },
    );
    expect(composerText(screen())).toBe(`› ${WORDS}rs`);
  });
});

it('⏎ on a trust gate over typed words continues the run and keeps the words in the composer', {
  timeout: 240_000,
}, async (context) => {
  await withTrustGateOverWords(context, async (child, screen) => {
    child.write('\r');
    await vi.waitFor(
      () => {
        expect(screen()).not.toContain(TRUST_GATE);
        expect(screen()).toContain('Run continued');
      },
      { timeout: 60_000 },
    );
    expect(composerText(screen())).toBe(`› ${WORDS}`);
  });
});
