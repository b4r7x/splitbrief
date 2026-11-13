import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configPath } from '../../../src/core/config/load/document.js';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { reapOrphanRunners } from '../../../src/engine/orchestrator/run/orphan-reaper.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { trustDeclaredRunners } from '#testing/helpers/runner-trust.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  cli,
  createStopContinueFixture,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const COLS = 140;
const ROWS = 40;
const PATIENCE = { timeout: 60_000 };
const SCENARIO_TIMEOUT = { timeout: 200_000 };
const IGNORED_HEAD = '--implementer-api-base is ignored';
const FLAGS = ['--implementer-api-base', 'http://127.0.0.1:9/v1', '--implementer-model', 'm'];
const PLANNER_FLAG = ['--planner-api-key-env', 'PLANNER_KEY'];
const PLANNER_NOTICE =
  "--planner-api-key-env is ignored: the planner 'shell' runner does not use it.";
const FLAG_FIX = 'Fix: Remove the flag from the command.';
// A running stage clock at 0:07 or later: more than the 5 s a feedback row shows.
const SEVEN_SECONDS_IN = /\b(0:(0[7-9]|[1-5]\d)|[1-9]\d*:\d\d)\b/;

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

function linesWith(text: string, needle: string): string[] {
  return text.split('\n').filter((line) => line.includes(needle));
}

function offlineFetch(dir: string): string {
  const path = join(dir, 'offline.mjs');
  writeFileSync(
    path,
    "globalThis.fetch = async () => { throw new Error('Network disabled in ignored-flag E2E'); };\n",
  );
  return path;
}

// The planner call holds while the hold file exists, so the start of the run stays in view.
function holdingPlannerScript(hold: string): string {
  return `import { existsSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
const deadline = Date.now() + 150000;
while (existsSync(${JSON.stringify(hold)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
process.exit(1);
`;
}

// Each call writes the marker and holds while the hold file beside the project exists, then finishes.
function holdingImplementerScript(projectDir: string): string {
  const hold = join(projectDir, '..', 'hold');
  return `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
const deadline = Date.now() + 150000;
while (existsSync(${JSON.stringify(hold)}) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;
}

function stoppedRunFixture(): StopContinueFixture {
  const target = createStopContinueFixture(holdingImplementerScript);
  writeFileSync(join(target.tmpDir, 'hold'), '');
  return target;
}

const FINISHING_IMPLEMENTER = `import { mkdirSync, writeFileSync } from 'node:fs';
for await (const chunk of process.stdin) void chunk;
mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;

describe('e2e: a flag the seat does not use is told once', () => {
  it('shows no notice row on an interactive first run and prints none after the quit', async () => {
    fixture = createStopContinueFixture(() => '');
    unlinkSync(configPath(fixture.projectDir));
    const home = join(fixture.tmpDir, 'home');
    const bin = join(fixture.tmpDir, 'bin');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"fixture":true}\n');
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(bin, tool.command, 'process.exit(1);');
    }
    writeFakeNodeCli(
      bin,
      'claude',
      `
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('claude ${CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion}');
else if (args.includes('--help')) console.log('Claude Code fixture');
else if (args[0] === 'auth') console.log(JSON.stringify({ loggedIn: true }));
else { console.error('Unexpected model call'); process.exitCode = 1; }
`,
    );
    const environment = safeChildEnvironment(home, [bin]);
    const offline = offlineFetch(fixture.tmpDir);
    const stderrPath = join(fixture.tmpDir, 'stderr');
    const wrapperPath = join(fixture.tmpDir, 'terminal-cli.mjs');
    writeFileSync(
      wrapperPath,
      `import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
const child = spawn(process.execPath, [
  '--import', 'tsx', '--import', ${JSON.stringify(offline)},
  'src/cli.ts', ...process.argv.slice(2),
], { stdio: ['inherit', 'inherit', openSync(${JSON.stringify(stderrPath)}, 'w')] });
child.on('error', error => { console.error(error); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
`,
    );

    const result = await runWithPtyChild(
      {
        requirement: 'required',
        argv: [wrapperPath, 'start', 'x', ...FLAGS, '--project', fixture.projectDir],
        spawnOptions: {
          name: 'xterm-256color',
          cols: COLS,
          rows: ROWS,
          cwd: REPO_ROOT,
          env: { ...environment, XDG_STATE_HOME: fixture.stateHome },
        },
      },
      async (child) => {
        const exited = Promise.withResolvers<PtyExitEvent>();
        let didExit = false;
        const counted: string[] = [];
        let noticeShown = false;
        const terminal = new XtermHeadless.Terminal({
          cols: COLS,
          rows: ROWS,
          allowProposedApi: true,
          convertEol: true,
          scrollback: 0,
          logLevel: 'off',
        });
        const screen = () =>
          Array.from(
            { length: ROWS },
            (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
          ).join('\n');
        const exitListener = child.onExit((event) => {
          didExit = true;
          exited.resolve(event);
        });
        const dataListener = child.onData((data) => {
          terminal.write(data, () => {
            const text = screen();
            counted.push(...linesWith(text, 'all shown when you quit'));
            if (text.includes(IGNORED_HEAD)) noticeShown = true;
          });
        });
        try {
          await vi.waitFor(() => expect(screen()).toContain('Set up your crew'), {
            timeout: 20_000,
          });
          expect(noticeShown, 'a frame showed the ignored-flag notice').toBe(false);
          expect.soft(counted).toEqual([]);
          child.write('\x03');
          await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'));
          child.write('\x03');
          await vi.waitFor(() => expect(didExit).toBe(true), { timeout: 5000 });
          expect(await exited.promise).toMatchObject({ exitCode: 0 });
          expect(noticeShown, 'a frame showed the ignored-flag notice').toBe(false);
          expect(linesWith(readFileSync(stderrPath, 'utf8'), 'is ignored')).toEqual([]);
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
    expect(result).toBeUndefined();
  });

  it('prints no notice on a headless first run that finds no crew', async () => {
    fixture = createStopContinueFixture(() => '');
    unlinkSync(configPath(fixture.projectDir));
    mkdirSync(join(fixture.tmpDir, 'bin'));
    const restorePath = activateSafeCliShimPath(join(fixture.tmpDir, 'bin'));
    try {
      vi.stubEnv('NODE_OPTIONS', `--import=${offlineFetch(fixture.tmpDir)}`);
      vi.stubEnv('HOME', join(fixture.tmpDir, 'home'));

      const run = await cli(fixture, ['start', ...FLAGS, 'Add a greeting helper']);

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain('No config found and no ready crew is available.');
      expect(linesWith(run.stderr, 'is ignored')).toEqual([]);
    } finally {
      restorePath();
    }
  });

  it('prints no notice on a blocked headless start whose config holds a CLI implementer', async () => {
    fixture = createStopContinueFixture(() => '');
    writeConfig(
      fixture.projectDir,
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'cli', tool: 'claude-code' },
      }),
    );
    mkdirSync(join(fixture.tmpDir, 'bin'));
    const restorePath = activateSafeCliShimPath(join(fixture.tmpDir, 'bin'));
    try {
      vi.stubEnv('NODE_OPTIONS', `--import=${offlineFetch(fixture.tmpDir)}`);
      vi.stubEnv('HOME', join(fixture.tmpDir, 'home'));

      const run = await cli(fixture, ['start', ...FLAGS, 'Add a greeting helper']);

      expect(run.exitCode).toBe(1);
      expect(linesWith(run.stderr, 'is ignored')).toEqual([]);
    } finally {
      restorePath();
    }
  });

  it(
    'names the ignored flag as a warning that stays at the start of the run',
    SCENARIO_TIMEOUT,
    async () => {
      fixture = createStopContinueFixture(() => '');
      const target = fixture;
      const hold = join(target.tmpDir, 'hold');
      const plannerPath = join(target.tmpDir, 'holding-planner.mjs');
      writeFileSync(hold, '');
      writeFileSync(plannerPath, holdingPlannerScript(hold));
      const config = loadConfig(target.projectDir).config;
      if (config.planner.kind !== 'shell')
        throw new Error('The fixture must declare a shell planner.');
      writeConfig(target.projectDir, {
        ...config,
        planner: { ...config.planner, args: [plannerPath] },
      });
      const trustHome = useTrustHome('ignored-flag-warning');
      const environment: Readonly<Record<string, string>> = {
        ...safeChildEnvironment(trustHome.home),
        XDG_STATE_HOME: target.stateHome,
      };
      try {
        await trustDeclaredRunners({
          projectDir: target.projectDir,
          config: loadConfig(target.projectDir).config,
          pathEnv: environment.PATH ?? '',
        });
        const result = await runWithPtyChild(
          {
            requirement: 'required',
            argv: [
              '--import',
              'tsx',
              '--import',
              offlineFetch(target.tmpDir),
              'src/cli.ts',
              'start',
              'Add a greeting helper',
              ...PLANNER_FLAG,
              '--allow-repo-runners',
              '--project',
              target.projectDir,
            ],
            spawnOptions: {
              name: 'xterm-256color',
              cols: COLS,
              rows: ROWS,
              cwd: REPO_ROOT,
              env: environment,
            },
          },
          async (child) => {
            const exited = Promise.withResolvers<PtyExitEvent>();
            let didExit = false;
            const terminal = new XtermHeadless.Terminal({
              cols: COLS,
              rows: ROWS,
              allowProposedApi: true,
              convertEol: true,
              scrollback: 0,
              logLevel: 'off',
            });
            const screen = () =>
              Array.from(
                { length: ROWS },
                (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
              ).join('\n');
            const exitListener = child.onExit((event) => {
              didExit = true;
              exited.resolve(event);
            });
            const dataListener = child.onData((data) => terminal.write(data));
            try {
              await expect.poll(screen, PATIENCE).toContain(FLAG_FIX);
              expect(linesWith(screen(), PLANNER_NOTICE)).toHaveLength(1);
              await expect.poll(screen, PATIENCE).toMatch(SEVEN_SECONDS_IN);
              expect(linesWith(screen(), PLANNER_NOTICE)).toHaveLength(1);
              expect(linesWith(screen(), FLAG_FIX)).toHaveLength(1);
            } finally {
              unlinkSync(hold);
              try {
                if (!didExit) await terminatePtyProcessGroup(child, exited.promise);
                await reapOrphanRunners(target.projectDir);
              } finally {
                dataListener.dispose();
                exitListener.dispose();
                terminal.dispose();
              }
            }
          },
        );
        expect(result).toBeUndefined();
      } finally {
        trustHome.restore();
      }

      const plain = createStopContinueFixture(() => FINISHING_IMPLEMENTER, { isolation: 'none' });
      try {
        const run = await cli(plain, ['start', 'smoke', ...PLANNER_FLAG]);

        expect(run.exitCode, run.stderr).toBe(0);
        expect(linesWith(run.stderr, 'is ignored')).toEqual([PLANNER_NOTICE]);
        expect(linesWith(run.stderr, FLAG_FIX)).toEqual([FLAG_FIX]);
      } finally {
        cleanupTempDir(plain.tmpDir);
      }
    },
  );

  it(
    'tells a flag a continue does not use on stderr under --plain and below the resume line on the screen',
    SCENARIO_TIMEOUT,
    async () => {
      fixture = stoppedRunFixture();
      const plainTarget = fixture;
      await startAndSignal(plainTarget, 'SIGINT', plainTarget.isolationTreesDir);
      unlinkSync(join(plainTarget.tmpDir, 'hold'));

      const continued = await cli(plainTarget, ['continue', ...PLANNER_FLAG], {
        timeoutMs: 120_000,
      });

      expect(continued.exitCode, continued.stderr).toBe(0);
      expect(linesWith(continued.stderr, 'is ignored')).toEqual([PLANNER_NOTICE]);
      expect(linesWith(continued.stderr, FLAG_FIX)).toEqual([FLAG_FIX]);
      expect(linesWith(continued.stderr, 'Working tree has')).toEqual([]);

      const target = stoppedRunFixture();
      const trustHome = useTrustHome('ignored-flag-continue');
      try {
        await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
        const environment: Readonly<Record<string, string>> = {
          ...safeChildEnvironment(trustHome.home),
          XDG_STATE_HOME: target.stateHome,
        };
        await trustDeclaredRunners({
          projectDir: target.projectDir,
          config: loadConfig(target.projectDir).config,
          pathEnv: environment.PATH ?? '',
        });
        const result = await runWithPtyChild(
          {
            requirement: 'required',
            argv: [
              '--import',
              'tsx',
              '--import',
              offlineFetch(target.tmpDir),
              'src/cli.ts',
              'continue',
              ...PLANNER_FLAG,
              '--allow-repo-runners',
              '--project',
              target.projectDir,
            ],
            spawnOptions: {
              name: 'xterm-256color',
              cols: COLS,
              rows: ROWS,
              cwd: REPO_ROOT,
              env: environment,
            },
          },
          async (child) => {
            const exited = Promise.withResolvers<PtyExitEvent>();
            let didExit = false;
            const terminal = new XtermHeadless.Terminal({
              cols: COLS,
              rows: ROWS,
              allowProposedApi: true,
              convertEol: true,
              scrollback: 0,
              logLevel: 'off',
            });
            const rows = () =>
              Array.from(
                { length: ROWS },
                (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '',
              );
            const screen = () => rows().join('\n');
            const exitListener = child.onExit((event) => {
              didExit = true;
              exited.resolve(event);
            });
            const dataListener = child.onData((data) => terminal.write(data));
            try {
              await expect.poll(screen, PATIENCE).toContain(FLAG_FIX);
              const shown = rows();
              const resumed = shown.findIndex((line) => line.includes('Run continued'));
              const notice = shown.findIndex((line) => line.includes(PLANNER_NOTICE));
              expect(resumed, screen()).toBeGreaterThanOrEqual(0);
              expect(notice, screen()).toBeGreaterThan(resumed);
              expect(linesWith(screen(), PLANNER_NOTICE)).toHaveLength(1);
              expect(linesWith(screen(), FLAG_FIX)).toHaveLength(1);
            } finally {
              unlinkSync(join(target.tmpDir, 'hold'));
              try {
                if (!didExit) await terminatePtyProcessGroup(child, exited.promise);
                await reapOrphanRunners(target.projectDir);
              } finally {
                dataListener.dispose();
                exitListener.dispose();
                terminal.dispose();
              }
            }
          },
        );
        expect(result).toBeUndefined();
      } finally {
        trustHome.restore();
        cleanupTempDir(target.tmpDir);
      }
    },
  );

  it('tells a seat setting that spec and review do not apply on stderr once, with its fix', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const config = loadConfig(fixture.projectDir).config;
    writeConfig(fixture.projectDir, {
      ...config,
      planner: { ...config.planner, temperature: 0.2 },
    });
    const summary = 'PLAN: the temperature setting is not applied: ';
    const fix = 'Fix: Delete temperature from planner in .splitbrief/config.yaml.';

    const spec = await cli(fixture, ['spec', 'Add a greeting helper']);

    expect(spec.exitCode, spec.stderr).toBe(0);
    expect(linesWith(spec.stderr, 'the temperature setting is not applied')).toEqual([
      expect.stringMatching(new RegExp(`^${summary}`)),
    ]);
    expect(linesWith(spec.stderr, 'Fix: Delete temperature')).toEqual([fix]);

    writeFileSync(join(fixture.projectDir, 'notes.txt'), 'a change to review\n');
    const review = await cli(fixture, ['review']);

    expect(linesWith(review.stderr, 'the temperature setting is not applied')).toEqual([
      expect.stringMatching(new RegExp(`^${summary}`)),
    ]);
    expect(linesWith(review.stderr, 'Fix: Delete temperature')).toEqual([fix]);
  });

  it('names an effort flag the PLAN tool does not take as an ignored flag, not as a config key', async () => {
    fixture = createStopContinueFixture(() => FINISHING_IMPLEMENTER, { isolation: 'none' });

    const run = await cli(fixture, ['start', 'smoke', '--planner-effort', 'high']);

    expect(run.exitCode, run.stderr).toBe(0);
    expect(linesWith(run.stderr, '--planner-effort is ignored: ')).toHaveLength(1);
    expect(linesWith(run.stderr, FLAG_FIX)).toEqual([FLAG_FIX]);
    expect(linesWith(run.stderr, 'Delete effort from planner')).toEqual([]);
  });

  it('names the @effort of --reviewer that the review tool does not take, and how to remove it', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const bin = join(fixture.tmpDir, 'bin');
    mkdirSync(bin);
    const verdict = JSON.stringify({ tasks: [], criteria: [], findings: [] });
    writeFakeNodeCli(
      bin,
      'opencode',
      `const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  console.log(${JSON.stringify(JSON.stringify([{ id: 'opencode-go', name: 'OpenCode Go', connections: [{ type: 'credential' }] }]))});
  process.exit(0);
}
if (args[0] !== 'run') process.exit(1);
require('node:fs').readFileSync(0, 'utf8');
console.log(JSON.stringify({ type: 'text', part: { type: 'text', text: ${JSON.stringify(verdict)} } }));
console.log(JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', tokens: { input: 40, output: 20 } } }));`,
    );
    writeFileSync(join(fixture.projectDir, 'notes.txt'), 'a change to review\n');
    const restorePath = activateSafeCliShimPath(bin);
    try {
      vi.stubEnv('HOME', join(fixture.tmpDir, 'home'));

      const review = await cli(fixture, ['review', '--reviewer', 'opencode@high']);

      expect(review.exitCode, review.stderr).toBe(0);
      expect(linesWith(review.stderr, 'is ignored')).toEqual([
        '@high in --reviewer is ignored: the OpenCode CLI variant sets the effort.',
      ]);
      expect(linesWith(review.stderr, 'Fix:')).toEqual(['Fix: Remove @high from --reviewer.']);
      expect(linesWith(review.stderr, '--reviewer-effort')).toEqual([]);
    } finally {
      restorePath();
    }
  });
});
