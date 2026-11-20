import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { expect, vi } from 'vitest';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild } from '../../integration/cli/pty/run.js';

export interface ClosedRunScreen {
  screen: () => string;
  write: (keys: string) => void;
  waitForText: (...texts: string[]) => Promise<void>;
  waitForNoText: (text: string) => Promise<void>;
}

export type ClosedRunLaunch = Readonly<{
  /** Text from the loaded record that identifies a settled screen. */
  settledText?: string;
  /** The node arguments that start the CLI from the repository root. */
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  viewport: Readonly<{ cols: number; rows: number }>;
}>;

/**
 * Starts the CLI in a PTY, opens the one run of its project from the sessions list, as a user
 * does, and hands its screen to `read` once the closed run settles.
 */
export async function openClosedRun<T>(
  launch: ClosedRunLaunch,
  read: (run: ClosedRunScreen) => Promise<T>,
): Promise<T> {
  const { viewport } = launch;
  const result = await runWithPtyChild(
    {
      requirement: 'required',
      argv: launch.argv,
      spawnOptions: {
        name: 'xterm-256color',
        ...viewport,
        cwd: resolve(import.meta.dirname, '../../..'),
        env: launch.env,
      },
    },
    async (child) => {
      const terminal = new XtermHeadless.Terminal({
        ...viewport,
        allowProposedApi: true,
        logLevel: 'off',
      });
      const exited = Promise.withResolvers<PtyExitEvent>();
      const screen = () =>
        Array.from(
          { length: viewport.rows },
          (_, row) =>
            terminal.buffer.active
              .getLine(terminal.buffer.active.viewportY + row)
              ?.translateToString(true) ?? '',
        ).join('\n');
      const data = child.onData((chunk) => terminal.write(chunk));
      const exit = child.onExit((event) => exited.resolve(event));
      const waitForText = async (...texts: string[]) => {
        await vi.waitFor(
          () => {
            for (const text of texts) expect(screen()).toContain(text);
          },
          { timeout: 30_000 },
        );
      };
      const waitForNoText = async (text: string) => {
        await vi.waitFor(() => expect(screen()).not.toContain(text), { timeout: 30_000 });
      };
      try {
        await waitForText('Describe your feature');
        child.write('/sessions');
        await waitForText('/sessions');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        child.write('\r');
        await waitForText('Sessions · 1');
        await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        child.write('\r');
        // The first frame comes before the run's history: the summary settles once the transcript
        // holds the lines above it.
        await waitForText('Run closed', launch.settledText ?? 'lines above');
        return {
          value: await read({
            screen,
            write: (keys) => child.write(keys),
            waitForText,
            waitForNoText,
          }),
        };
      } finally {
        await terminatePtyProcessGroup(child, exited.promise);
        data.dispose();
        exit.dispose();
        terminal.dispose();
      }
    },
  );
  if (!('value' in result)) throw new Error(result.reason);
  return result.value;
}
