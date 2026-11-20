import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { attachmentFailureText } from '../../../src/core/attachments/failure.js';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { sessionDir } from '../../../src/core/paths.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { saveSummary } from '../../../src/core/sessions/io.js';
import { LONG_COMPOSER_DRAFT } from '../../visual/fixtures/common.js';
import { wholeFrames } from '../helpers/whole-frames.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { PTY_SUBMIT_INPUT } from '../../integration/cli/pty/contract.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

type Viewport = Readonly<{ cols: number; rows: number }>;
type Screen = Readonly<{
  rows: () => string[];
  write: (keys: string) => void;
  dir: string;
}>;

/** Starts SPLITBRIEF on Home in a project whose tools answer offline, then hands over the screen. */
async function onHome(
  viewport: Viewport,
  drive: (screen: Screen) => Promise<void>,
  skip: (reason: string) => void,
  seedProject?: (projectDir: string) => void,
): Promise<void> {
  await withTempDir('home-notice', async (dir) => {
    const home = join(dir, 'home');
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    mkdirSync(home);
    mkdirSync(binDir);
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const runnerPath = join(dir, 'runner.mjs');
    writeFileSync(runnerPath, "throw new Error('No workflow may start in the Home notice E2E');\n");
    if (seedProject) seedProject(projectDir);
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'shell', command: process.execPath, args: [runnerPath] },
        implementer: {
          kind: 'shell',
          command: process.execPath,
          args: [runnerPath],
          model: 'auto',
        },
        workflow: { isolation: 'none' },
      }),
    );
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
    }
    const offlinePath = join(dir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('Offline Home notice E2E'); };\n",
    );
    const restorePath = activateSafeCliShimPath(binDir);
    let environment: Readonly<Record<string, string>>;
    try {
      environment = safeChildEnvironment(home, [binDir]);
    } finally {
      restorePath();
    }
    const result = await runWithPtyChild(
      {
        requirement: process.env.SPLITBRIEF_REQUIRE_PTY === '1' ? 'required' : 'optional',
        argv: ['--import', 'tsx', '--import', offlinePath, 'src/cli.ts', '--project', projectDir],
        spawnOptions: {
          name: 'xterm-256color',
          ...viewport,
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: { ...environment, XDG_STATE_HOME: join(dir, 'state') },
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
        const rows = () =>
          Array.from(
            { length: viewport.rows },
            (_, row) =>
              terminal.buffer.active
                .getLine(terminal.buffer.active.viewportY + row)
                ?.translateToString(true) ?? '',
          );
        const frames = wholeFrames((data) => terminal.write(data));
        const dataListener = child.onData(frames.feed);
        const exitListener = child.onExit((event) => {
          frames.flush();
          didExit = true;
          exited.resolve(event);
        });
        try {
          await vi.waitFor(() => expect(rows().join('\n')).toContain('Describe your feature'), {
            timeout: 30_000,
          });
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
          await drive({ rows, write: (keys) => child.write(keys), dir });
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
    if (result) skip(result.reason);
  });
}

const REFUSAL = `Cannot send: ${attachmentFailureText('not-a-file')} File: folder.`;

/** The notice that stands on the composer box: its rows, from the top frame row to the composer. */
function noticeAbove(rows: readonly string[], phrase: string) {
  const first = rows.findIndex((row) => row.includes(phrase));
  const bottom = rows.findIndex((row, index) => index > first && row.trim().startsWith('╰'));
  const body = rows.slice(first, bottom).map((row) => row.trim());
  // Each row is the frame, a padding cell, the glyph or its hanging indent, then the text.
  const texts = body.map((row) => row.slice(4, -2).trimEnd());
  return {
    top: rows[first - 1] ?? '',
    body,
    texts,
    bottom: rows[bottom] ?? '',
    composer: rows[bottom + 1] ?? '',
  };
}

describe('e2e: a refused attachment on Home', { timeout: 120_000 }, () => {
  it.for([
    { cols: 120, rows: 40 },
    { cols: 80, rows: 24 },
    { cols: 60, rows: 18 },
  ])(
    'frames the refusal above the composer, as wide as its text, at $cols columns',
    async (viewport, context) => {
      await onHome(
        viewport,
        async ({ rows, write, dir }) => {
          const folder = join(dir, 'folder');
          mkdirSync(folder);
          const draft = `smoke @${folder}`;
          write(draft);
          await vi.waitFor(() => {
            const input = rows()
              .filter((row) => row.trim().startsWith('│'))
              .map((row) => row.trim().slice(1, -1).trim().replace(/^›\s*/u, ''))
              .join('');
            expect(input.replaceAll(' ', '')).toContain(draft.replaceAll(' ', ''));
          });
          write(PTY_SUBMIT_INPUT);

          await vi.waitFor(
            () => {
              const notice = noticeAbove(rows(), 'Cannot send:');
              expect(notice.body[0]?.startsWith('│ ⚠ Cannot send:')).toBe(true);
              for (const row of notice.body) {
                expect(row.startsWith('│ ') && row.endsWith(' │')).toBe(true);
              }
              expect(notice.texts.join(' ')).toBe(REFUSAL);
              const width = Math.max(...notice.texts.map((text) => text.length)) + 6;
              expect(notice.top.trim()).toBe(`╭${'─'.repeat(width - 2)}╮`);
              expect(notice.bottom.trim()).toBe(`╰${'─'.repeat(width - 2)}╯`);
              expect(notice.composer.trim()).toMatch(/^╭─+╮$/u);
              const left = notice.top.indexOf('╭') - notice.composer.indexOf('╭');
              const right = notice.composer.indexOf('╮') - notice.top.indexOf('╮');
              expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
              expect(width).toBeLessThan(notice.composer.trim().length);
            },
            { timeout: 15_000 },
          );
        },
        (reason) => context.skip(reason),
      );
    },
  );
});

describe('e2e: the Home heading on a small terminal', { timeout: 120_000 }, () => {
  it('keeps the wordmark above the crew over a long draft and eight sessions at 60x18', async (context) => {
    await onHome(
      { cols: 60, rows: 18 },
      async ({ rows, write, dir }) => {
        // A first launch without a config opens Setup. Home reloads a config removed after launch.
        unlinkSync(join(dir, 'project', '.splitbrief', 'config.yaml'));
        await vi.waitFor(() => expect(rows().join('\n')).toContain('No config.'), {
          timeout: 15000,
        });
        for (let start = 0; start < LONG_COMPOSER_DRAFT.length; start += 32) {
          const chunk = LONG_COMPOSER_DRAFT.slice(start, start + 32);
          write(chunk);
          const tail = chunk.replaceAll(' ', '');
          await vi.waitFor(() => expect(rows().join('').replace(/[│ ]/gu, '')).toContain(tail));
        }
        await vi.waitFor(() => {
          const lines = rows().map((row) => row.trim());
          expect(lines[0]).toBe('splitbrief');
          expect(lines[1]).toMatch(/^PLAN .*BUILD .*REVIEW /u);
          expect(lines).toContain('7 more');
          expect(lines.join(' ')).toContain('label printer.');
        });
      },
      (reason) => context.skip(reason),
      (projectDir) => {
        for (let index = 0; index < 8; index++) {
          const id = `recent-${index}`;
          mkdirSync(sessionDir(projectDir, id), { recursive: true });
          saveSummary(
            { projectDir, sessionId: id },
            makeSession({ id, feature: `Feature ${index}`, startedAt: 1000 + index }),
          );
        }
      },
    );
  });

  it('heads a 40-column Home with the one-row wordmark and names every seat', async (context) => {
    const viewport = { cols: 40, rows: 18 };
    await onHome(
      viewport,
      async ({ rows }) => {
        await vi.waitFor(
          () => {
            const lines = rows();
            const filled = lines.map((row) => row.trim()).filter((row) => row !== '');
            expect(filled[0]).toBe('splitbrief');
            expect(filled[1]?.startsWith('PLAN ')).toBe(true);
            const crew = lines.join('\n');
            expect(crew.match(/\bBUILD /gu)).toHaveLength(1);
            expect(crew.match(/\bREVIEW /gu)).toHaveLength(1);
            for (const row of lines) expect(row.length).toBeLessThanOrEqual(viewport.cols);
          },
          { timeout: 15_000 },
        );
      },
      (reason) => context.skip(reason),
    );
  });
});

it('spans the workflow composer with one matching slash command in a reopened run', {
  timeout: 60_000,
}, async (context) => {
  const feature = 'Check the word count';
  await onHome(
    { cols: 120, rows: 40 },
    async ({ rows, write }) => {
      write('\x12');
      await vi.waitFor(() => expect(rows().join('\n')).toContain('↑↓ select · ⏎ open'));
      write('\r');
      await vi.waitFor(() => expect(rows().join('\n')).toContain('/ for a command'), {
        timeout: 10_000,
      });
      write('/scr');
      await vi.waitFor(() => expect(rows().join('\n')).toContain('Scroll conversation'));
      const lines = rows();
      const option = lines.findIndex((line) => line.includes('Scroll conversation'));
      const input = lines.findIndex((line) => line.includes('› /scr'));
      expect(input).toBeGreaterThan(option);
      const composer = lines[input - 1];
      expect(composer).toMatch(/^ +╭─+╮$/u);
      expect(lines[option - 1]).toBe(composer);
    },
    (reason) => context.skip(reason),
    (projectDir) => {
      const ref = { projectDir, sessionId: 'word-count' };
      const at = '2026-10-11T00:00:00.000Z';
      saveState(ref, { ...createInitialState(feature), closed: { as: 'ended', at } });
      saveSummary(
        ref,
        makeSession({ id: ref.sessionId, feature, status: 'ended', completedAt: Date.parse(at) }),
      );
    },
  );
});
