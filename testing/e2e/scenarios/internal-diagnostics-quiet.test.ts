import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import XtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATE_FILE, SUMMARY_FILE, sessionDir } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { writeActive } from '../../../src/core/sessions/active-pointer.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
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
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const COLS = 140;
const ROWS = 40;
const OLDER_RUNS = ['2026-01-05-older-run', '2026-01-06-older-run'] as const;
const OLDER_SUMMARY = { name: 'Add a greeting helper', started: '2026-01-05' };
const OLDER_STATE = { stateVersion: 2, feature: 'Add a greeting helper' };
const SKILL_ID = 'house-style';
const INVALID_SESSION = 'Warning: invalid session';
const SKIPPED_STATE = 'Warning: skipped';
const SKILL_RECOVERED = 'Skill frontmatter is not valid YAML';
const COUNT_LINE = 'all shown when you quit';
const INTERNAL = [INVALID_SESSION, SKIPPED_STATE, SKILL_RECOVERED, COUNT_LINE];
const LOGGED_DIAGNOSTIC = / WARN \d+ \[diagnostics\] (.*)$/;

/** YAML refuses the second `: ` of the description, so the skill loads by a line scan. */
const SKILL_SOURCE = `---
name: ${SKILL_ID}
description: Use when a source file changes. Triggers: each edit
---

Keep each name short.
`;

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

function linesWith(text: string, needles: readonly string[]): string[] {
  return text.split('\n').filter((line) => needles.some((needle) => line.includes(needle)));
}

/** The text of each diagnostic that the debug log of the project holds. */
function loggedDiagnostics(projectDir: string): string[] {
  const path = join(projectDir, '.splitbrief', 'logs', 'debug.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const text = LOGGED_DIAGNOSTIC.exec(line)?.[1];
      return text === undefined ? [] : [text];
    });
}

function offlineFetch(dir: string): string {
  const path = join(dir, 'offline.mjs');
  writeFileSync(
    path,
    "globalThis.fetch = async () => { throw new Error('Network disabled in the internal-diagnostics E2E'); };\n",
  );
  return path;
}

function implementerScript(): string {
  return `import { mkdirSync, writeFileSync } from 'node:fs';

for await (const chunk of process.stdin) void chunk;

mkdirSync('src', { recursive: true });
writeFileSync(${JSON.stringify(MARKER_FILE)}, ${JSON.stringify(MARKER_SOURCE)});
writeFileSync(${JSON.stringify(GREET_FILE)}, ${JSON.stringify(GREET_SOURCE)});
`;
}

/** A file of a run folder that an older version left in the project; this version cannot read it. */
function writeOlderRunFile(
  projectDir: string,
  sessionId: string,
  file: string,
  content: unknown,
): void {
  const runDir = sessionDir(projectDir, sessionId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, file), `${JSON.stringify(content)}\n`);
}

describe('e2e: an internal diagnostic goes to the debug log only', () => {
  it('shows no diagnostic on the home screen or on stderr after quit, and logs it', async () => {
    fixture = createStopContinueFixture(() => '');
    const projectDir = fixture.projectDir;
    for (const sessionId of OLDER_RUNS) {
      writeOlderRunFile(projectDir, sessionId, SUMMARY_FILE, OLDER_SUMMARY);
    }
    const home = join(fixture.tmpDir, 'home');
    const bin = join(fixture.tmpDir, 'bin');
    mkdirSync(home);
    mkdirSync(bin);
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(bin, tool.command, 'process.exit(1);');
    }
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
        argv: [wrapperPath, '--project', projectDir],
        spawnOptions: {
          name: 'xterm-256color',
          cols: COLS,
          rows: ROWS,
          cwd: REPO_ROOT,
          env: { ...environment, XDG_STATE_HOME: fixture.stateHome, SPLITBRIEF_DEBUG: '1' },
        },
      },
      async (child) => {
        const exited = Promise.withResolvers<PtyExitEvent>();
        let didExit = false;
        const shown = new Set<string>();
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
            for (const line of linesWith(screen(), INTERNAL)) shown.add(line.trim());
          });
        });
        try {
          await vi.waitFor(() => expect(screen()).toContain('Describe your feature'), {
            timeout: 20_000,
          });
          child.write('\x03');
          await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'));
          child.write('\x03');
          await vi.waitFor(() => expect(didExit).toBe(true), { timeout: 5000 });
          expect(await exited.promise).toMatchObject({ exitCode: 0 });
          expect.soft([...shown], 'screen rows that hold a diagnostic').toEqual([]);
          expect
            .soft(
              linesWith(readFileSync(stderrPath, 'utf8'), INTERNAL),
              'stderr lines that hold a diagnostic',
            )
            .toEqual([]);
          expect(loggedDiagnostics(projectDir), 'diagnostics in the debug log').toContainEqual(
            expect.stringContaining(INVALID_SESSION),
          );
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

  it('prints no diagnostic on stderr of status or of a plain run, and logs the diagnostic of each', async () => {
    fixture = createStopContinueFixture(implementerScript);
    const [activeRun] = OLDER_RUNS;
    writeOlderRunFile(fixture.projectDir, activeRun, SUMMARY_FILE, OLDER_SUMMARY);
    writeOlderRunFile(fixture.projectDir, activeRun, STATE_FILE, OLDER_STATE);
    writeActive({ projectDir: fixture.projectDir, sessionId: activeRun });
    const skillDir = join(fixture.projectDir, '.claude', 'skills', SKILL_ID);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), SKILL_SOURCE);
    const home = join(fixture.tmpDir, 'home');
    const bin = join(fixture.tmpDir, 'bin');
    mkdirSync(home);
    mkdirSync(bin);
    const restorePath = activateSafeCliShimPath(bin);
    try {
      vi.stubEnv('NODE_OPTIONS', `--import=${offlineFetch(fixture.tmpDir)}`);
      vi.stubEnv('HOME', home);
      vi.stubEnv('SPLITBRIEF_DEBUG', '1');

      const status = await cli(fixture, ['status']);
      expect(status.exitCode, status.stderr).toBe(0);
      expect
        .soft(linesWith(status.stderr, INTERNAL), 'stderr lines of status that hold a diagnostic')
        .toEqual([]);
      expect(
        loggedDiagnostics(fixture.projectDir),
        'diagnostics in the debug log after status',
      ).toContainEqual(expect.stringContaining(SKIPPED_STATE));

      const run = await cli(fixture, ['start', 'Add a greeting helper', '--skills', SKILL_ID]);
      expect(run.exitCode, run.stderr).toBe(0);
      expect
        .soft(linesWith(run.stderr, INTERNAL), 'stderr lines of the run that hold a diagnostic')
        .toEqual([]);
      expect(loggedDiagnostics(fixture.projectDir), 'diagnostics in the debug log').toContainEqual(
        expect.stringContaining(SKILL_RECOVERED),
      );
    } finally {
      restorePath();
    }
  });
});
