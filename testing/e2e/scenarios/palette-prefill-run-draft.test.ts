import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import XtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionsRoot } from '../../../src/core/paths.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { readSessionDraft } from '../../../src/core/sessions/draft.js';
import { PROMPT_TYPEAHEAD_GRACE_MS } from '../../../src/lib/terminal/typeahead-grace.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { PtyExitEvent } from '../../integration/cli/pty/capability.js';
import { terminatePtyProcessGroup } from '../../integration/cli/pty/monitor.js';
import { runWithPtyChild, safeChildEnvironment } from '../../integration/cli/pty/run.js';
import {
  cli,
  createStopContinueFixture,
  escapingImplementerScript,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const VIEWPORT = { cols: 100, rows: 30 };
const DRAFT = 'keep the scanner screen as it is';
let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('e2e: a command taken from the palette over a typed run draft', {
  timeout: 180_000,
}, () => {
  it.for([
    {
      title: 'keeps the text typed after /crew under the draft',
      command: 'crew',
      typed: 'plan now',
      erased: false,
      kept: `${DRAFT}\n/crew plan now`,
    },
    {
      title: 'keeps only the draft behind a /steer edited back to its prefill',
      command: 'steer',
      typed: 'x',
      erased: true,
      kept: DRAFT,
    },
  ] as const)('$title when the run is left and reopened', async (step, context) => {
    fixture = createStopContinueFixture(escapingImplementerScript);
    const target = fixture;
    const halted = await cli(target, ['start', 'smoke']);
    expect(halted.exitCode, halted.stderr).toBe(1);
    const [sessionId = ''] = readdirSync(sessionsRoot(target.projectDir));
    const ref = { projectDir: target.projectDir, sessionId };

    const home = join(target.tmpDir, 'home');
    const binDir = join(target.tmpDir, 'bin');
    mkdirSync(home);
    mkdirSync(binDir);
    for (const tool of Object.values(CLI_TOOL_CATALOG)) {
      writeFakeNodeCli(binDir, tool.command, 'process.exit(1);');
    }
    const offlinePath = join(target.tmpDir, 'offline.mjs');
    writeFileSync(
      offlinePath,
      "globalThis.fetch = async () => { throw new Error('Offline palette run draft E2E'); };\n",
    );
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
          target.projectDir,
        ],
        spawnOptions: {
          name: 'xterm-256color',
          ...VIEWPORT,
          cwd: REPO_ROOT,
          env: { ...safeChildEnvironment(home, [binDir]), XDG_STATE_HOME: target.stateHome },
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
        const shows = (expected: string | RegExp, timeout = 10_000) =>
          vi.waitFor(
            () =>
              typeof expected === 'string'
                ? expect(text()).toContain(expected)
                : expect(text()).toMatch(expected),
            { timeout },
          );
        const openRun = async () => {
          child.write('/sessions');
          await shows('Browse past sessions');
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
          child.write('\r');
          await shows('Sessions · 1');
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
          child.write('\r');
          await shows('Needs you');
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
        };
        const dataListener = child.onData((data) => terminal.write(data));
        const exitListener = child.onExit((event) => {
          didExit = true;
          exited.resolve(event);
        });
        try {
          await shows('Describe your feature', 30_000);
          await delay(PROMPT_TYPEAHEAD_GRACE_MS);
          await openRun();

          await shows('Type a correction…');
          child.write(DRAFT);
          await shows(`› ${DRAFT}`);
          child.write('\x0b');
          await shows('Type a command…');
          child.write(step.command);
          await shows(`▌ /${step.command}`);
          child.write('\r');
          await shows(`› /${step.command} `);
          expect(text()).not.toContain(DRAFT);
          child.write(step.typed);
          await shows(`› /${step.command} ${step.typed}`);
          if (step.erased) {
            for (let i = 0; i < step.typed.length; i++) child.write('\x7f');
            await vi.waitFor(() => expect(text()).not.toContain(`/${step.command} ${step.typed}`));
            await shows(`› /${step.command} `);
          }

          child.write('\x1b');
          await shows('Recent sessions');
          expect(readSessionDraft(ref)).toEqual({
            version: 1,
            parts: [{ kind: 'text', text: step.kept }],
          });

          await openRun();
          await shows(DRAFT);
          if (step.erased) expect(text()).not.toContain(`/${step.command}`);
          else await shows(`/${step.command} ${step.typed}`);
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
  });
});
