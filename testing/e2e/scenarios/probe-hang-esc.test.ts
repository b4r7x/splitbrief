import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const VIEWPORT = { cols: 120, rows: 40 };
const ESC = '\u001b';

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return cause instanceof Error && 'code' in cause && cause.code === 'ESRCH';
  }
}

// The built binary, the real clock and a sign-in check that never answers: the status row names
// the tool, the check and its time after ten seconds, and esc ends the wait and the check's process.
it('names a hung sign-in check after ten seconds and esc ends it with its process', async () => {
  await withTempDir('probe-hang-esc', async (dir) => {
    const home = join(dir, 'home');
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    const armed = join(dir, 'hang-armed');
    const pidFile = join(dir, 'sign-in.pid');
    const authLog = join(dir, 'auth-list.log');
    mkdirSync(binDir);
    createTestGitRepo(projectDir, {
      'package.json': `${JSON.stringify({ scripts: { test: 'node -e 0' } })}\n`,
    });
    const opencodeData = join(home, '.local', 'share', 'opencode');
    mkdirSync(opencodeData, { recursive: true });
    writeFileSync(
      join(opencodeData, 'auth.json'),
      `${JSON.stringify({ anthropic: { type: 'api' } })}\n`,
    );
    const seat = { kind: 'cli', tool: 'opencode', model: 'anthropic/claude-sonnet-5' } as const;
    writeConfig(
      projectDir,
      makeConfig({
        planner: seat,
        implementer: seat,
        reviewer: seat,
        workflow: { isolation: 'none' },
      }),
    );
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
    }
    // The tool check at startup gets its answers; once the test arms it, the sign-in check holds.
    writeFakeNodeCli(
      binDir,
      'opencode',
      `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'list') {
  fs.appendFileSync(${JSON.stringify(authLog)}, 'auth list\\n');
  if (fs.existsSync(${JSON.stringify(armed)})) {
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1_000_000);
  } else {
    console.log(${JSON.stringify(JSON.stringify([{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'credential' }] }]))});
    process.exit(0);
  }
} else {
  process.exit(1);
}`,
    );
    const offline = join(dir, 'offline.mjs');
    writeFileSync(
      offline,
      "globalThis.fetch = async () => { throw new Error('Network disabled in probe hang E2E'); };\n",
    );

    const restorePath = activateSafeCliShimPath(binDir);
    let environment: Readonly<Record<string, string>>;
    try {
      environment = safeChildEnvironment(home, [binDir]);
    } finally {
      restorePath();
    }
    await runWithPtyChild(
      {
        requirement: 'required',
        argv: ['--import', offline, 'dist/cli.js', '--project', projectDir],
        spawnOptions: {
          name: 'xterm-256color',
          ...VIEWPORT,
          cwd: REPO_ROOT,
          env: { ...environment, XDG_STATE_HOME: join(dir, 'state') },
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
        const text = () =>
          Array.from(
            { length: VIEWPORT.rows },
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
        const shows = (expected: string | RegExp, timeout = 10_000) =>
          vi.waitFor(
            () =>
              typeof expected === 'string'
                ? expect(text()).toContain(expected)
                : expect(text()).toMatch(expected),
            { timeout },
          );
        try {
          await shows('Describe your feature', 30_000);
          await expect.poll(() => existsSync(authLog), { timeout: 30_000 }).toBe(true);
          await vi.waitFor(() => expect(text()).not.toMatch(/(Checking|Refreshing) your tools/u), {
            timeout: 30_000,
          });
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
          writeFileSync(armed, '');
          child.write('hang the sign-in check');
          await shows('hang the sign-in check');
          child.write('\r');

          await expect.poll(() => existsSync(pidFile), { timeout: 15_000 }).toBe(true);
          const pid = Number(readFileSync(pidFile, 'utf8'));
          await shows(/Checking tools · OpenCode CLI sign-in 1\ds · esc cancel/u, 20_000);
          expect(processGone(pid)).toBe(false);

          child.write(ESC);
          await vi.waitFor(() => expect(text()).not.toContain('OpenCode CLI sign-in'), {
            timeout: 5_000,
          });
          await expect.poll(() => processGone(pid), { timeout: 5_000 }).toBe(true);
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
  });
});
