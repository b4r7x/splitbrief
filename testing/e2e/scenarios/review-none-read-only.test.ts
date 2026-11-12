import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import {
  activateSafeCliShimPath,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { moveCursorTo } from '../helpers/move-cursor.js';
import { wholeFrames } from '../helpers/whole-frames.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

type Screen = Readonly<{
  text: () => string;
  write: (keys: string) => void;
  shows: (expected: string | RegExp, timeout?: number) => Promise<unknown>;
}>;

/** Boots the TUI under REVIEW None on a Claude Code planner with one custom model. */
async function underReviewNone(
  input: Readonly<{
    prefix: string;
    viewport: Readonly<{ cols: number; rows: number }>;
    steps: (screen: Screen, projectDir: string) => Promise<void>;
  }>,
): Promise<string | undefined> {
  return withTempDir(input.prefix, async (dir) => {
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet', customModels: ['my-model'] },
        implementer: { kind: 'cli', tool: 'claude-code', model: 'sonnet' },
        reviewer: 'none',
        validation: { endChecks: true },
        workflow: { isolation: 'none' },
      }),
    );
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
    }
    const claude = installCompatibleCliShim({
      directory: binDir,
      tool: 'claude-code',
    });
    const offlinePath = join(dir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('Offline REVIEW None E2E'); };\n",
    );

    const restorePath = activateSafeCliShimPath(binDir);
    let environment: Readonly<Record<string, string>>;
    try {
      environment = safeChildEnvironment(claude.sessionStateHome, [binDir]);
    } finally {
      restorePath();
    }
    const result = await runWithPtyChild(
      {
        requirement: process.env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
        argv: ['--import', 'tsx', '--import', offlinePath, 'src/cli.ts', '--project', projectDir],
        spawnOptions: {
          name: 'xterm-256color',
          ...input.viewport,
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: { ...environment, XDG_STATE_HOME: join(dir, 'state') },
        },
      },
      async (child) => {
        const terminal = new XtermHeadless.Terminal({
          ...input.viewport,
          allowProposedApi: true,
          logLevel: 'off',
        });
        const exited = Promise.withResolvers<PtyExitEvent>();
        let didExit = false;
        const text = () =>
          Array.from(
            { length: input.viewport.rows },
            (_, row) =>
              terminal.buffer.active
                .getLine(terminal.buffer.active.viewportY + row)
                ?.translateToString(true) ?? '',
          ).join('\n');
        const write = (keys: string) => child.write(keys);
        const shows = (expected: string | RegExp, timeout = 10_000) =>
          vi.waitFor(
            () =>
              typeof expected === 'string'
                ? expect(text()).toContain(expected)
                : expect(text()).toMatch(expected),
            { timeout },
          );
        const frames = wholeFrames((data) => terminal.write(data));
        const dataListener = child.onData(frames.feed);
        const exitListener = child.onExit((event) => {
          frames.flush();
          didExit = true;
          exited.resolve(event);
        });
        try {
          await shows('Describe your feature', 30_000);
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
          await input.steps({ text, write, shows }, projectDir);
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
    return result?.reason;
  });
}

describe('e2e: a key on what REVIEW None holds names the reason and changes nothing', {
  timeout: 120_000,
}, () => {
  it('names the reason at 60x18 when the user presses Enter on End-of-run checks', async (context) => {
    const reason = 'Read-only while REVIEW is None: no review runs.';
    const skipped = await underReviewNone({
      prefix: 'review-none-locked-row',
      viewport: { cols: 60, rows: 18 },
      steps: async (screen, projectDir) => {
        screen.write('/settings');
        await screen.shows('▌ /settings');
        screen.write('\r');
        await screen.shows('Settings');
        screen.write('end-of-run');
        await screen.shows(/▌.*End-of-run checks/);
        expect(screen.text()).not.toContain(reason);

        screen.write('\r');

        await screen.shows(reason);
        expect(loadConfig(projectDir).config.validation.endChecks).toBe(true);
      },
    });
    if (skipped !== undefined) context.skip(skipped);
  });

  it('refuses a delete of the planner custom model in the REVIEW picker and keeps None', async (context) => {
    const skipped = await underReviewNone({
      prefix: 'review-none-picker-delete',
      viewport: { cols: 120, rows: 40 },
      steps: async (screen, projectDir) => {
        screen.write('/crew');
        await screen.shows('▌ /crew  Who fills each seat');
        screen.write('\r');
        await screen.shows('Settings');
        await moveCursorTo(screen.text, screen.write, '\x1b[B', /▌ REVIEW/);
        screen.write('\r');
        await screen.shows('REVIEW · tool, model, effort');
        await moveCursorTo(screen.text, screen.write, '\x1b[B', /▌ Claude Code CLI/);
        await screen.shows(/My Model +Custom/);
        screen.write('\x1b[C');
        await screen.shows(/▌ auto +tool decides/);
        screen.write('my model');
        await screen.shows(/▌ My Model +Custom/);

        screen.write('\x04');

        await screen.shows('my-model belongs to the planner. Remove it from the planner.');
        const config = loadConfig(projectDir).config;
        expect(config.reviewer).toBe('none');
        expect(config.planner).toMatchObject({ customModels: ['my-model'] });
      },
    });
    if (skipped !== undefined) context.skip(skipped);
  });
});
