import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import YAML from 'yaml';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createDefaultConfig } from '../../../src/core/config/load/defaults.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { CONFIG_FILE, REVIEWS_DIR, REVIEW_FILE, SPLITBRIEF_DIR } from '../../../src/core/paths.js';
import { AUTOMATIC_MODEL } from '../../../src/core/providers/automatic-model.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { registerReviewCommand } from '../../../src/cli/commands/review.js';

// Runner availability is a live network claim; the shared no-claim mock keeps
// the verdict off whatever daemon this machine happens to be running.
vi.mock('../../../src/engine/runners/probe-availability.js', () => ({
  probeRunnerAvailability: async (
    ...args: Parameters<
      typeof import('../../../src/engine/runners/probe-availability.js').probeRunnerAvailability
    >
  ) => (await import('#testing/helpers/start-command.js')).probeRunnerAvailabilityMock(...args),
}));

const REVIEW_TEXT = [
  '### Verdict',
  'pass_with_notes',
  '',
  '### Findings',
  '- **Warning**: the changed line has no test.',
  '',
  '### Summary',
  'One reviewer call over the working tree.',
].join('\n');

const CHANGED_LINE = 'the-line-the-reviewer-must-see';

let tmp: string;
let binDir: string;
let runLogPath: string;
let restorePath: (() => void) | undefined;
let priorApiKey: string | undefined;

function writeConfig(dir: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, SPLITBRIEF_DIR, CONFIG_FILE),
    YAML.stringify(
      toYaml({
        ...createDefaultConfig(),
        planner: {
          kind: 'cli',
          tool: 'claude-code',
          model: AUTOMATIC_MODEL,
          authChannel: 'api-key',
        },
        implementer: {
          kind: 'cli',
          tool: 'claude-code',
          model: AUTOMATIC_MODEL,
          authChannel: 'api-key',
        },
        ...overrides,
      }),
    ),
    'utf-8',
  );
}

/**
 * A `shell` review seat: the whole point is that it needs no CLI tool at all,
 * so this run installs no fake `claude` and would fail if preparation still
 * enumerated the planner or the implementer.
 */
function inlineShellReviewer(): Record<string, unknown> {
  const child = [
    "const fs = require('node:fs');",
    "const prompt = fs.readFileSync(0, 'utf-8');",
    `fs.appendFileSync(${JSON.stringify(runLogPath)}, JSON.stringify({ args: [], prompt }) + '\\n');`,
    `process.stdout.write(${JSON.stringify(REVIEW_TEXT)});`,
  ].join('\n');
  return {
    kind: 'shell',
    command: process.execPath,
    args: ['-e', child],
    model: 'local-shell-reviewer',
  };
}

/**
 * The reviewer the session-free custom runtime exists for: an `agent` seat whose
 * execution tuple is declared under `customCommands`, so `createReviewer` takes
 * the configured-custom branch and the review text arrives as a leased declared
 * artifact rather than on stdout. The child records its own cwd so the test can
 * prove the stage — and with it the lease — was disposed.
 */
function configuredAgentReviewer(): Record<string, unknown> {
  const child = [
    "const fs = require('node:fs');",
    "const prompt = fs.readFileSync(0, 'utf-8');",
    `fs.appendFileSync(${JSON.stringify(runLogPath)}, JSON.stringify({ args: [], prompt, cwd: process.cwd() }) + '\\n');`,
    `fs.writeFileSync(process.env.SPLITBRIEF_DECLARED_ARTIFACT_PATH, ${JSON.stringify(REVIEW_TEXT)});`,
  ].join('\n');
  return {
    reviewer: {
      kind: 'agent',
      command: process.execPath,
      args: ['-e', child],
      model: 'configured-agent-reviewer',
    },
    customCommands: {
      'configured-agent-reviewer': {
        label: 'Configured agent reviewer',
        contract: 'direct',
        executable: process.execPath,
        argv: ['-e', child],
      },
    },
  };
}

/**
 * A physical `claude` that answers the admission probes and records every real
 * call, so the test can assert the spawn count and the argument vector the
 * review seat emitted rather than a mocked factory's promise.
 */
function installFakeClaude(): void {
  const executablePath = join(binDir, 'claude');
  const version = CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion;
  const script = [
    '#!/usr/bin/env node',
    "const { appendFileSync, readFileSync } = require('node:fs');",
    `const runLogPath = ${JSON.stringify(runLogPath)};`,
    `const reviewText = ${JSON.stringify(REVIEW_TEXT)};`,
    `const version = ${JSON.stringify(version)};`,
    'const args = process.argv.slice(2);',
    'if (args.length === 1 && args[0] === "--version") {',
    '  console.log("claude " + version);',
    '  process.exit(0);',
    '}',
    'if (args.length === 2 && args[0] === "auth" && args[1] === "status") {',
    '  console.log("authenticated");',
    '  process.exit(0);',
    '}',
    // Every other probe (--help among them) answers nothing: a help text with no
    // recognisable flag leaves the arg-vector preflight conservative.
    'if (!args.includes("-p")) process.exit(0);',
    'const prompt = readFileSync(0, "utf-8");',
    'appendFileSync(runLogPath, JSON.stringify({ args, prompt }) + "\\n");',
    'console.log(JSON.stringify({ type: "assistant", session_id: "fake-review-session", message: { content: [{ type: "text", text: reviewText }] } }));',
    'console.log(JSON.stringify({ type: "result", result: reviewText, session_id: "fake-review-session", usage: { input_tokens: 40, output_tokens: 20 } }));',
  ].join('\n');
  writeFileSync(executablePath, script + '\n', 'utf-8');
  chmodSync(executablePath, 0o755);
  restorePath = activateSafeCliShimPath(binDir);
}

function readRunLog(): Array<{ args: string[]; prompt: string; cwd?: string }> {
  if (!existsSync(runLogPath)) return [];
  return readFileSync(runLogPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { args: string[]; prompt: string; cwd?: string });
}

async function runReview(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const program = new Command();
  program.name('splitbrief').exitOverride();
  registerReviewCommand(program);
  const chunks: string[] = [];
  program.configureOutput({
    writeOut: (str) => {
      chunks.push(str);
    },
    writeErr: (str) => {
      chunks.push(str);
    },
  });
  const originalLog = console.log;
  const originalWrite = process.stdout.write.bind(process.stdout);
  console.log = (...parts: unknown[]) => {
    chunks.push(parts.map(String).join(' ') + '\n');
  };
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  let exitCode = 0;
  try {
    await program.parseAsync(['node', 'splitbrief', 'review', ...args]);
  } catch (err) {
    const failure = err as { exitCode?: number; message?: string };
    exitCode = typeof failure.exitCode === 'number' ? failure.exitCode : 1;
    if (failure.message !== undefined) chunks.push(failure.message + '\n');
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }
  return { stdout: chunks.join(''), exitCode };
}

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-review-one-shot');
  binDir = createTempDir('cli-review-one-shot-bin');
  runLogPath = join(binDir, 'claude-runs.jsonl');
  createTestGitRepo(tmp);
  mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
  priorApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-only-review-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  restorePath?.();
  restorePath = undefined;
  if (priorApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = priorApiKey;
  cleanupTempDir(binDir);
  cleanupTempDir(tmp);
});

describe('CLI integration: splitbrief review', () => {
  it('lists the seat and base flags in its help', () => {
    const program = new Command();
    program.name('splitbrief').exitOverride();
    registerReviewCommand(program);

    const help = program.commands[0]?.helpInformation().replace(/\s+/g, ' ') ?? '';

    expect(help).toContain('--reviewer <spec>');
    expect(help).toContain('<tool>[:<model>][@<effort>]');
    expect(help).toContain('--base <ref>');
    // A one-shot review runs no hooks, so it offers no hook-trust flag; the
    // auth escape hatch its own remediation names is the one it does offer.
    expect(help).not.toContain('--allow-hooks');
    expect(help).toContain('--allow-unverified-auth');
  });

  it('refuses an option-shaped --base instead of handing it to git', async () => {
    writeConfig(tmp);
    const probe = join(tmp, 'probe.txt');

    const { stdout, exitCode } = await runReview(['--project', tmp, '--base', `--output=${probe}`]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("cannot start with '-'");
    expect(existsSync(probe)).toBe(false);
    expect(readRunLog()).toHaveLength(0);
  });

  it('prints nothing to review on a clean tree and exits 0', async () => {
    writeConfig(tmp);

    const { stdout, exitCode } = await runReview(['--project', tmp]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('nothing to review');
    expect(readRunLog()).toHaveLength(0);
  });

  it('reviews the working tree in one read-only call, without a session', async () => {
    writeConfig(tmp);
    writeFileSync(join(tmp, 'init.txt'), `init\n${CHANGED_LINE}\n`, 'utf-8');
    installFakeClaude();

    const { stdout, exitCode } = await runReview(['--project', tmp]);

    expect(exitCode).toBe(0);
    const runs = readRunLog();
    expect(runs).toHaveLength(1);
    const call = runs[0];
    expect(call?.args).toContain('--permission-mode');
    expect(call?.args[(call?.args.indexOf('--permission-mode') ?? -1) + 1]).toBe('plan');
    expect(call?.prompt).toContain(CHANGED_LINE);
    expect(call?.prompt).toContain(
      'none — review for correctness, scope creep, and test coverage of the diff',
    );
    expect(stdout).toContain('pass_with_notes');
    // The streamed review is markdown: its line breaks survive to stdout.
    expect(stdout).toContain('### Verdict\npass_with_notes');
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);

    const reviewsRoot = join(tmp, SPLITBRIEF_DIR, REVIEWS_DIR);
    const stamps = readdirSync(reviewsRoot);
    expect(stamps).toHaveLength(1);
    expect(readFileSync(join(reviewsRoot, stamps[0] ?? '', REVIEW_FILE), 'utf-8')).toContain(
      'pass_with_notes',
    );
  });

  it('reviews through an inline shell reviewer without admitting any other runner', async () => {
    writeConfig(tmp, { reviewer: inlineShellReviewer() });
    writeFileSync(join(tmp, 'init.txt'), `init\n${CHANGED_LINE}\n`, 'utf-8');

    const { stdout, exitCode } = await runReview(['--project', tmp, '--allow-repo-runners']);

    expect(exitCode).toBe(0);
    const runs = readRunLog();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toContain(CHANGED_LINE);
    expect(stdout).toContain('pass_with_notes');
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'active'))).toBe(false);
  });

  it('reviews through a configured-custom reviewer seat', { timeout: 60_000 }, async () => {
    writeConfig(tmp, configuredAgentReviewer());
    writeFileSync(join(tmp, 'init.txt'), `init\n${CHANGED_LINE}\n`, 'utf-8');

    const { stdout, exitCode } = await runReview(['--project', tmp, '--allow-repo-runners']);

    expect(exitCode).toBe(0);
    const runs = readRunLog();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toContain(CHANGED_LINE);
    // The child wrote nothing to stdout: this verdict came from the leased
    // declared artifact, reviewed and released by the session-free runtime.
    expect(stdout).toContain('pass_with_notes');
    const stageDir = runs[0]?.cwd ?? '';
    expect(stageDir).not.toBe('');
    expect(stageDir).not.toBe(tmp);
    expect(existsSync(stageDir)).toBe(false);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'sessions'))).toBe(false);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'active'))).toBe(false);

    const reviewsRoot = join(tmp, SPLITBRIEF_DIR, REVIEWS_DIR);
    const stamps = readdirSync(reviewsRoot);
    expect(stamps).toHaveLength(1);
    expect(readFileSync(join(reviewsRoot, stamps[0] ?? '', REVIEW_FILE), 'utf-8')).toContain(
      'pass_with_notes',
    );
  });
});
