import { PassThrough } from 'node:stream';
import { Box, Text, render } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { useAppKeys, type AppKeyDeps } from '../../../src/app/keys.js';
import { FeedbackRow } from '../../../src/features/workflow/components/feedback-row.js';
import { installTerminalSelection } from '../../../src/lib/terminal/selection.js';
import { createFilteredStdin } from '../../../src/lib/terminal/filtered-stdin/create.js';
import { setActiveFilteredStdin } from '../../../src/lib/terminal/filtered-stdin/active.js';
import type { CopyOutcome } from '../../../src/lib/clipboard/clipboard.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { controlsStore } from '../../../src/stores/ui/controls.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import { lifecycleStore } from '../../../src/stores/workflow/lifecycle.js';
import { stopStore } from '../../../src/stores/workflow/stop.js';

const CTRL_C = '\x03';
const QUIT_HINT = 'Press ctrl+c again to quit';
const cleanup: (() => void)[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 40));

function Keys({ exit, deps }: { exit: () => void; deps: AppKeyDeps }) {
  useAppKeys({ exit, deps });
  return (
    <Box flexDirection="column">
      <Text>selected text</Text>
      <FeedbackRow />
    </Box>
  );
}

function setup(
  running: boolean | 'at-rest' = false,
  copy = vi.fn<(text: string) => Promise<CopyOutcome>>().mockResolvedValue('native'),
) {
  if (running) {
    const projectDir = '/tmp/selection-key-fixture';
    const sessionId = 'selection-key-fixture';
    const prepared = makePreparedExecution({
      projectDir,
      sessionId,
      feature: 'selection',
      config: makeConfig(),
    });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir, sessionId } }),
      execution: running === 'at-rest' ? { kind: 'at-rest' } : { kind: 'local', prepared },
    });
    lifecycleStore.__testReset({
      status: running === 'at-rest' ? 'paused' : 'running',
      phase: 'implementing',
    });
  }
  const exit = vi.fn();
  const stop = vi.fn(() => {
    stopStore.request('stop-now');
    return true;
  });
  const deps = {
    requestQuit: vi.fn((done: () => void) => {
      done();
    }),
    requestStopNow: stop,
    refreshSkills: vi.fn().mockResolvedValue(undefined),
  };
  const source = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: true,
    setRawMode: () => source,
    ref: () => source,
    unref: () => source,
  });
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 24, isTTY: true });
  const output: string[] = [];
  stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const selection = installTerminalSelection({
    stdout: stdout as unknown as NodeJS.WriteStream,
    copy,
    reportError: feedbackStore.setError,
    onCopyKey: (result) => {
      filtered.stdin.emit('selection-copy', result);
    },
  });
  const muted = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const filtered = createFilteredStdin(source as unknown as NodeJS.ReadStream, {
    handleMouse: selection.handleMouse,
    filterInput: selection.filterInput,
    onPaste: selection.clear,
  });
  setActiveFilteredStdin(filtered);
  const instance = render(<Keys exit={exit} deps={deps} />, {
    stdin: filtered.stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  cleanup.push(() => {
    instance.unmount();
    selection.dispose();
    filtered.disable();
    setActiveFilteredStdin(undefined);
    source.destroy();
    stdout.destroy();
    muted.mockRestore();
  });
  const press = async (key = CTRL_C) => {
    source.write(Buffer.from(key));
    await tick();
  };
  const select = async () => {
    await tick();
    await press('\x1b[<0;1;1M\x1b[<32;13;1M\x1b[<0;13;1m');
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith('selected text'));
  };
  return { exit, stop, copy, press, select, output: () => output.join('') };
}

beforeEach(() => {
  resetAllStores();
  vi.stubEnv('CI', 'false');
});
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  resetAllStores();
  vi.unstubAllEnvs();
});

describe('Ctrl+C through mouse selection and the app stop ladder', () => {
  it('copies first, stops second, and quits third while running', async () => {
    const h = setup(true);
    await h.select();
    await h.press();
    expect(feedbackStore.get().message).toBe('Copied (native)');
    expect(h.output()).toContain('Copied (native)');
    expect(h.stop).not.toHaveBeenCalled();
    await h.press();
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
    await h.press();
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it.each([CTRL_C, '\x1b[99;5u'])('copies, arms quit, then quits at rest with %j', async (key) => {
    const h = setup('at-rest');
    await h.select();
    await h.press(key);
    expect(feedbackStore.get().message).toBe('Copied (native)');
    await h.press(key);
    expect(feedbackStore.get().message).toBe(QUIT_HINT);
    expect(h.exit).not.toHaveBeenCalled();
    await h.press(key);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it('spends one of two coalesced presses on copy and arms quit with the other', async () => {
    const h = setup();
    await h.select();
    await h.press(CTRL_C + CTRL_C);
    expect(feedbackStore.get().message).toBe(QUIT_HINT);
    expect(h.exit).not.toHaveBeenCalled();
    await h.press();
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it('quits on three coalesced presses after consuming only one copy', async () => {
    const h = setup();
    await h.select();
    await h.press(CTRL_C + CTRL_C + CTRL_C);
    expect(h.copy).toHaveBeenCalledTimes(2);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it('clears an older quit confirmation when Ctrl+C copies a selection', async () => {
    const h = setup();
    await tick();
    await h.press();
    expect(feedbackStore.get().message).toBe(QUIT_HINT);
    await h.select();
    await h.press();
    expect(feedbackStore.get().message).toBe('Copied (native)');
    await h.press();
    expect(feedbackStore.get().message).toBe(QUIT_HINT);
    expect(h.exit).not.toHaveBeenCalled();
    await h.press();
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it.each(['native', 'unavailable'] as const)(
    'a delayed %s copy answer preserves the newer quit confirmation',
    async (outcome) => {
      let answer: ((result: CopyOutcome) => void) | undefined;
      const copy = vi
        .fn<(text: string) => Promise<CopyOutcome>>()
        .mockResolvedValueOnce('native')
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        );
      const h = setup(false, copy);
      await h.select();
      await h.press();
      await h.press();
      expect(feedbackStore.get().message).toBe(QUIT_HINT);
      answer?.(outcome);
      await tick();
      expect(feedbackStore.get().message).toBe(QUIT_HINT);
      await h.press();
      expect(h.exit).toHaveBeenCalledTimes(1);
    },
  );

  it('reports a failed copy without advancing the stop ladder', async () => {
    const copy = vi
      .fn<(text: string) => Promise<CopyOutcome>>()
      .mockResolvedValueOnce('native')
      .mockResolvedValue('unavailable');
    const h = setup(true, copy);
    await h.select();
    await h.press();
    expect(feedbackStore.get()).toMatchObject({ message: 'Could not copy', isError: true });
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('shows the copy receipt while the gate owns the feedback row', async () => {
    controlsStore.setInputMode('review');
    const h = setup(true);
    await h.select();
    await h.press();
    expect(h.output()).toContain('Copied (native)');
  });
});
