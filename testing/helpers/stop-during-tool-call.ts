import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CLI_TOOL_CATALOG } from '../../src/core/runners/cli-tool/catalog.js';
import { writeFakeNodeCli } from './command-shim.js';
import { hermeticPath } from './compatible-cli-shim.js';
import { writeConfigYaml } from './config-io.js';
import { createTestGitRepo } from './git.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SIGN_IN_FILE = join('.commandcode', 'auth.json');
const MODEL_LIST = readFileSync(
  new URL('../fixtures/command-code/list-models.txt', import.meta.url),
  'utf8',
)
  .split('\n')
  .slice(2)
  .join('\n');
const HOLD_MS = 120_000;

type StopOptions = {
  args: readonly string[];
  during: 'status' | 'help' | 'seat';
  signal: NodeJS.Signals;
  to: 'process' | 'group';
  worker?: 'drain' | 'pipes';
};

interface StoppedCli {
  /** The CLI's exit code; null when a signal ended it. */
  exitCode: number | null;
  /** The signal that ended the CLI, when it did not exit by itself. */
  exitSignal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** From the signal to the CLI's exit. */
  stopMs: number;
  /** The check and sandbox temp folders in the CLI's temp folder, before and after the stop. */
  foldersBefore: string[];
  foldersAfter: string[];
  /** The copies of the sign-in file in the temp folder and project sandbox. */
  signInCopiesBefore: string[];
  signInCopiesAfter: string[];
  probeRecords: string[];
  /** Whether the tool still runs after the CLI exited. */
  toolRunning: boolean;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signals the CLI once the fake tool enters the requested call. */
export async function stopDuringToolCall(dir: string, options: StopOptions): Promise<StoppedCli> {
  const projectDir = join(dir, 'project');
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const tmp = join(dir, 't');
  const ready = join(dir, 'ready');
  const release = join(dir, 'release');
  for (const path of [projectDir, join(home, '.commandcode'), bin, tmp]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(home, SIGN_IN_FILE), '{"apiKey":"fixture"}\n');
  createTestGitRepo(projectDir);
  if (options.args[0] === 'review')
    writeFileSync(join(projectDir, 'init.txt'), 'A change to review.\n');
  writeConfigYaml(projectDir, {
    planner: { kind: 'cli', tool: 'command-code' },
    implementer: { kind: 'cli', tool: 'command-code' },
  });
  writeFakeNodeCli(
    bin,
    CLI_TOOL_CATALOG['command-code'].command,
    [
      "const { existsSync, readFileSync, renameSync, writeFileSync } = require('node:fs');",
      'const args = process.argv.slice(2);',
      "const call = args.includes('--version') ? 'version' : args[0] === 'status' ? 'status' :",
      "  args.includes('--help') ? 'help' : args.includes('-p') ? 'seat' : 'catalog';",
      `const version = ${JSON.stringify(CLI_TOOL_CATALOG['command-code'].compatibility.testedVersion)};`,
      `if (call !== ${JSON.stringify(options.during)}) {`,
      "  if (call === 'version') console.log(version);",
      "  if (call === 'status') console.log(JSON.stringify({ authenticated: true, version,",
      "    user: 'fixture', model: 'deepseek/deepseek-v4-flash', context_window: 1000000 }));",
      "  if (call === 'help') console.log('Command Code CLI');",
      `  if (call === 'catalog') console.log(${JSON.stringify(MODEL_LIST)});`,
      '  process.exit(0);',
      '}',
      "if (call === 'seat') readFileSync(0);",
      `const readyFile = ${JSON.stringify(ready)};`,
      'function recordReady(workerPid) {',
      "  const pending = readyFile + '.' + process.pid;",
      '  writeFileSync(pending, JSON.stringify({ pid: process.pid, workerPid }));',
      '  renameSync(pending, readyFile);',
      '}',
      ...workerScript(options.worker),
      `const deadline = Date.now() + ${HOLD_MS};`,
      'setInterval(() => {',
      `  if (existsSync(${JSON.stringify(release)}) || Date.now() > deadline) process.exit(1);`,
      '}, 50);',
    ].join('\n'),
  );

  const folders = () => readdirSync(tmp).filter((name) => /^(splitbrief-|sb-)/.test(name));
  const list = (root: string) =>
    existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }) : [];
  const signInCopies = () =>
    [tmp, join(projectDir, '.splitbrief', 'sandbox')].flatMap((root) =>
      list(root).filter((path) => path.endsWith(SIGN_IN_FILE)),
    );
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/cli.ts', ...options.args, '--project', projectDir],
    {
      cwd: REPO_ROOT,
      env: {
        PATH: hermeticPath([bin]),
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_CACHE_HOME: join(home, 'cache'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_STATE_HOME: join(dir, 'state'),
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        TSX_DISABLE_CACHE: '1',
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error('the CLI did not start');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  let exited = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    }),
  );

  try {
    while (!existsSync(ready)) {
      if (exited) {
        throw new Error(`the CLI exited before the ${options.during} call:\n${stdout}\n${stderr}`);
      }
      await sleep(20);
    }
    const foldersBefore = folders();
    const signInCopiesBefore = signInCopies();
    const stopAt = performance.now();
    process.kill(options.to === 'group' ? -pid : pid, options.signal);
    const end = await closed;
    const stopMs = performance.now() - stopAt;
    const tool = readReady(ready);
    return {
      exitCode: end.code,
      exitSignal: end.signal,
      stdout,
      stderr,
      stopMs,
      foldersBefore,
      foldersAfter: folders(),
      signInCopiesBefore,
      signInCopiesAfter: signInCopies(),
      probeRecords: list(join(projectDir, '.splitbrief', 'probes')),
      toolRunning: isRunning(tool.pid),
    };
  } finally {
    writeFileSync(release, '');
    if (existsSync(ready)) {
      const { workerPid } = readReady(ready);
      if (workerPid !== undefined && isRunning(workerPid)) process.kill(workerPid, 'SIGKILL');
    }
    if (!exited) process.kill(-pid, 'SIGKILL');
  }
}

function readReady(path: string): { pid: number; workerPid?: number } {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function workerScript(worker: StopOptions['worker']): string[] {
  if (worker === undefined) return ['recordReady();'];
  // The drain worker keeps reaping pending after the tool's pipes close. The detached worker
  // holds the pipes open after the tool group is gone. The test releases it in teardown.
  const pipes = worker === 'pipes';
  const stdio = pipes ? 'inherit' : 'ignore';
  return [
    "const { spawn } = require('node:child_process');",
    "const worker = spawn(process.execPath, ['-e',",
    `  "process.on('SIGTERM', () => {}); process.send('ready'); setTimeout(() => {}, ${HOLD_MS});"],`,
    `  { detached: ${pipes}, stdio: ['ignore', '${stdio}', '${stdio}', 'ipc'] });`,
    "worker.once('message', () => { recordReady(worker.pid); worker.disconnect(); });",
  ];
}
