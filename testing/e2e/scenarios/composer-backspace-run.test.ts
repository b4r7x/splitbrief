import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import XtermHeadless from '@xterm/headless';
import { expect, it, vi } from 'vitest';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { waitForStdinRead } from '../helpers/key-log.js';
import { forwardTerminalReplies } from '../helpers/terminal-replies.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';

const VIEWPORT = { cols: 100, rows: 30 };
const EMPTY_BOX = /^› +Describe your feature/;
const PREPARATION_BLOCKED = 'Tool preparation · Blocked';

interface Home {
  readonly write: (keys: string) => void;
  /** Pastes `text` as a terminal does: in brackets while the app has bracketed paste on. */
  readonly paste: (text: string) => void;
  /** True while the app has bracketed paste on. */
  readonly pasteMode: () => boolean;
  readonly screen: () => string;
  /** The rows of the composer box, joined. */
  readonly box: () => string;
  /** Waits until the key log shows that the CLI got `bytes` in one stdin read. */
  readonly waitForOneRead: (bytes: string) => Promise<void>;
  /** Sends `signal` to the CLI from outside, as `kill` does. */
  readonly signal: (signal: 'SIGTSTP' | 'SIGCONT') => void;
  /** The rows of the screen. */
  readonly rows: () => string[];
}

/**
 * Opens SPLITBRIEF home in a PTY, runs `drive`, then quits with Ctrl+C twice. With
 * `pasteWord: false` the terminal gives no word on bracketed paste.
 */
async function withHome(
  label: string,
  fullscreen: boolean,
  drive: (home: Home) => Promise<void>,
  skip: (reason: string) => void,
  pasteWord = true,
): Promise<void> {
  await withTempDir(label, async (dir) => {
    const home = join(dir, 'home');
    const projectDir = join(dir, 'project');
    const binDir = join(dir, 'bin');
    mkdirSync(home);
    mkdirSync(binDir);
    mkdirSync(join(projectDir, '.git', 'objects'), { recursive: true });
    mkdirSync(join(projectDir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const runnerPath = join(dir, 'runner.mjs');
    writeFileSync(runnerPath, "throw new Error('No workflow may start in the composer E2E');\n");
    writeConfig(
      projectDir,
      makeConfig({
        planner: { kind: 'shell', command: process.execPath, args: [runnerPath] },
        implementer: {
          kind: 'agent',
          command: process.execPath,
          args: [runnerPath],
          model: 'fixture',
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
      "globalThis.fetch = async () => { throw new Error('Offline composer E2E'); };\n",
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
        argv: [
          '--import',
          'tsx',
          '--import',
          offlinePath,
          'src/cli.ts',
          '--project',
          projectDir,
          ...(fullscreen ? [] : ['--no-fullscreen']),
        ],
        spawnOptions: {
          name: 'xterm-256color',
          ...VIEWPORT,
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          env: { ...environment, XDG_STATE_HOME: join(dir, 'state'), SPLITBRIEF_DEBUG_KEYS: '1' },
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
        const box = () =>
          screen()
            .split('\n')
            .filter((row) => row.includes('›'))
            .map((row) => row.replace(/[│]/g, '').trim())
            .join(' / ');
        const dataListener = child.onData((data) => terminal.write(data));
        const replyListener = forwardTerminalReplies(terminal, child, pasteWord);
        const exitListener = child.onExit((event) => {
          didExit = true;
          exited.resolve(event);
        });
        try {
          await vi.waitFor(() => expect(screen()).toContain('Describe your feature'), {
            timeout: 30_000,
          });
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
          await drive({
            write: (keys) => child.write(keys),
            paste: (text) =>
              child.write(terminal.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text),
            pasteMode: () => terminal.modes.bracketedPasteMode,
            screen,
            box,
            waitForOneRead: (bytes) => waitForStdinRead(projectDir, bytes),
            signal: (signal) => process.kill(child.pid, signal),
            rows: () => screen().split('\n'),
          });

          child.write('\x03');
          await vi.waitFor(() => expect(screen()).toContain('Press ctrl+c again to quit'));
          child.write('\x03');
          await vi.waitFor(() => expect(didExit).toBe(true), { timeout: 5_000 });
          expect(await exited.promise).toMatchObject({ exitCode: 0 });
        } finally {
          try {
            if (!didExit) await terminatePtyProcessGroup(child, exited.promise);
          } finally {
            dataListener.dispose();
            replyListener.dispose();
            exitListener.dispose();
            terminal.dispose();
          }
        }
      },
    );
    if (result) skip(result.reason);
  });
}

it.for([true, false])(
  'deletes one character per backspace byte of one terminal read and the word after the caret on Ctrl+Delete, fullscreen=%s',
  async (fullscreen, context) => {
    await withHome(
      'composer-backspace-run',
      fullscreen,
      async ({ write, screen }) => {
        const showsDraft = async (draft: string) => {
          await vi.waitFor(
            () => {
              const line = screen()
                .split('\n')
                .find((row) => row.includes('draft'));
              expect(line?.match(/draft\S*/)?.[0], screen()).toBe(draft);
            },
            { timeout: 10_000 },
          );
        };
        write('draft-xyz');
        await showsDraft('draft-xyz');
        write('\x7f\x7f');
        await showsDraft('draft-x');
        write('\x7f\x7fQ');
        await showsDraft('draftQ');
        write(' one two');
        await vi.waitFor(() => expect(screen()).toContain('draftQ one two'), {
          timeout: 10_000,
        });
        for (let step = 0; step < ' one two'.length; step++) write('\x1b[D');
        write('\x1b[3;5~\x05');
        await vi.waitFor(() => expect(screen()).toContain('draftQ two'), { timeout: 10_000 });
      },
      (reason) => context.skip(reason),
    );
  },
);

function shows(screen: () => string, expected: string | RegExp): Promise<void> {
  return vi.waitFor(
    () =>
      typeof expected === 'string'
        ? expect(screen()).toContain(expected)
        : expect(screen()).toMatch(expected),
    { timeout: 10_000 },
  );
}

it.for([true, false])(
  'keeps the letters typed in the same read as ↑ as the draft that ↓ brings back, fullscreen=%s',
  async (fullscreen, context) => {
    await withHome(
      'composer-recall-one-read',
      fullscreen,
      async ({ write, screen, box }) => {
        write('/help');
        await shows(screen, '/help  Show help');
        write('\r');
        await shows(screen, 'Help · commands & shortcuts');
        write('\x1b');
        await vi.waitFor(() => expect(screen()).not.toContain('Help · commands & shortcuts'), {
          timeout: 10_000,
        });
        write('draft');
        await vi.waitFor(() => expect(box()).toBe('› draft'), { timeout: 10_000 });

        write('-new\x1b[A');
        await vi.waitFor(() => expect(box()).toBe('› /help'), { timeout: 10_000 });
        write('\x1b[B');
        await vi.waitFor(() => expect(box()).not.toBe('› /help'), { timeout: 10_000 });

        expect(box()).toBe('› draft-new');
      },
      (reason) => context.skip(reason),
    );
  },
);

it.for([true, false])(
  'runs no command when ⏎ follows in the same read the Backspaces that delete it, fullscreen=%s',
  async (fullscreen, context) => {
    await withHome(
      'composer-deleted-command-one-read',
      fullscreen,
      async ({ write, screen, box, waitForOneRead }) => {
        write('/he');
        await shows(screen, '/help  Show help');

        write('\x7f\x7f\x7f\rok');
        await waitForOneRead('\x7f\x7f\x7f\rok');
        await shows(screen, /› ok|Help · commands & shortcuts/);

        expect(screen()).not.toContain('Help · commands & shortcuts');
        expect(box()).toBe('› ok');
        write('\x7f'.repeat('ok'.length));
        await vi.waitFor(() => expect(box()).toMatch(EMPTY_BOX), { timeout: 10_000 });
      },
      (reason) => context.skip(reason),
    );
  },
);

it.for([true, false])(
  'runs the command that ↓ selects when ⏎ follows in the same read, fullscreen=%s',
  async (fullscreen, context) => {
    await withHome(
      'composer-selected-command-one-read',
      fullscreen,
      async ({ write, screen }) => {
        write('/se');
        await shows(screen, '/settings');

        write('\x1b[B\r');
        await shows(screen, /Settings|Sessions · \d/);

        expect(screen()).not.toMatch(/Sessions · \d/);
        write('\x1b');
        await shows(screen, 'Describe your feature');
      },
      (reason) => context.skip(reason),
    );
  },
);

it.for([true, false])(
  'sends the text that one read types with its ⏎, fullscreen=%s',
  async (fullscreen, context) => {
    await withHome(
      'composer-text-enter-one-read',
      fullscreen,
      async ({ write, screen, waitForOneRead }) => {
        write('hello\r');
        await waitForOneRead('hello\r');
        // The project has no commit, so the start that the sent text asks for stops at its check.
        await shows(screen, PREPARATION_BLOCKED);
        write('\x1b');
        await vi.waitFor(() => expect(screen()).not.toContain(PREPARATION_BLOCKED), {
          timeout: 10_000,
        });
      },
      (reason) => context.skip(reason),
    );
  },
);

// A terminal that gives no word on bracketed paste may send a paste as typed keys, so a pasted
// line break and a typed Enter of one read are the same bytes there.
it.for([true, false])(
  'keeps ok and ⏎ of one read as a draft of two rows on a terminal that gives no word on bracketed paste, and sends it on the next ⏎, fullscreen=%s',
  async (fullscreen, context) => {
    await withHome(
      'composer-no-word-one-read',
      fullscreen,
      async ({ write, screen, rows, pasteMode, waitForOneRead }) => {
        await vi.waitFor(() => expect(pasteMode()).toBe(true), { timeout: 10_000 });
        write('ok\r');
        await waitForOneRead('ok\r');
        await vi.waitFor(
          () => {
            const all = rows();
            const first = all.findIndex((row) => row.includes('› ok'));
            expect(first, screen()).toBeGreaterThanOrEqual(0);
            expect(all[first + 1]?.replace(/[│\s]/g, ''), screen()).toBe('');
          },
          { timeout: 10_000 },
        );
        expect(screen()).not.toContain(PREPARATION_BLOCKED);

        write('\r');
        await shows(screen, PREPARATION_BLOCKED);
        write('\x1b');
        await vi.waitFor(() => expect(screen()).not.toContain(PREPARATION_BLOCKED), {
          timeout: 10_000,
        });
      },
      (reason) => context.skip(reason),
      false,
    );
  },
);

// A stop from outside gives the terminal back to the shell, and `fg` sends the SIGCONT that takes
// it again.
it.for([true, false])(
  'reads keys again with bracketed paste on after an outside stop and fg, fullscreen=%s',
  async (fullscreen, context) => {
    await withHome(
      'composer-stop-fg',
      fullscreen,
      async ({ write, box, pasteMode, signal }) => {
        await vi.waitFor(() => expect(pasteMode()).toBe(true), { timeout: 10_000 });
        write('before');
        await vi.waitFor(() => expect(box()).toBe('› before'), { timeout: 10_000 });

        signal('SIGTSTP');
        await vi.waitFor(() => expect(pasteMode()).toBe(false), { timeout: 10_000 });
        signal('SIGCONT');
        await vi.waitFor(() => expect(pasteMode()).toBe(true), { timeout: 10_000 });
        write(' after');
        await vi.waitFor(() => expect(box()).toBe('› before after'), { timeout: 10_000 });
      },
      (reason) => context.skip(reason),
    );
  },
);

it.for([true, false])(
  'turns bracketed paste on and keeps a pasted text of three lines in the composer, fullscreen=%s',
  async (fullscreen, context) => {
    await withHome(
      'composer-paste-three-lines',
      fullscreen,
      async ({ paste, pasteMode, screen }) => {
        await vi.waitFor(() => expect(pasteMode()).toBe(true), { timeout: 10_000 });
        paste('line one\rline two\rline three');
        await vi.waitFor(
          () => {
            const rows = screen().split('\n');
            const first = rows.findIndex((row) => row.includes('› line one'));
            expect(first, screen()).toBeGreaterThanOrEqual(0);
            expect(rows[first + 1]).toContain('line two');
            expect(rows[first + 2]).toContain('line three');
          },
          { timeout: 10_000 },
        );
        expect(screen()).not.toContain(PREPARATION_BLOCKED);
      },
      (reason) => context.skip(reason),
    );
  },
);

it.for([true, false])(
  'folds a pasted text of four lines into one paste item, fullscreen=%s',
  async (fullscreen, context) => {
    await withHome(
      'composer-paste-four-lines',
      fullscreen,
      async ({ paste, pasteMode, screen, box }) => {
        await vi.waitFor(() => expect(pasteMode()).toBe(true), { timeout: 10_000 });
        paste('line one\rline two\rline three\rline four');
        await vi.waitFor(() => expect(box(), screen()).toContain('› [Pasted #1 +4 lines]'), {
          timeout: 10_000,
        });
        expect(screen()).not.toContain(PREPARATION_BLOCKED);
      },
      (reason) => context.skip(reason),
    );
  },
);
