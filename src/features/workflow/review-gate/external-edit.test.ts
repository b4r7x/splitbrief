import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeInputMode } from '#testing/helpers/review-input-mode.js';
import { terminalSequences } from '../../../lib/terminal/control.js';
import { setActiveTerminalHandover } from '../../../lib/terminal/editor-handover.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { runEditor, type SpawnEditor } from '../external-editor/spawn.js';
import { openReviewFileExternally } from './external-edit.js';

type EditorOutcome =
  | { kind: 'close'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'error'; error: Error };

describe('openReviewFileExternally stale-owner feedback', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'review-parser-test-'));
    feedbackStore.reset();
    reviewStore.reset();
    runViewStore.__testReset({ phase: 'reviewing-plan' });
    lifecycleStore.__testReset({ status: 'running' });
    vi.stubEnv('VISUAL', 'vim');
    setActiveTerminalHandover({
      fullscreen: false,
      mouse: false,
      sourceStdin: {
        isRaw: false,
        pause: vi.fn(),
        resume: vi.fn(),
      },
    });
  });

  afterEach(() => {
    setActiveTerminalHandover(undefined);
    feedbackStore.reset();
    reviewStore.reset();
    lifecycleStore.reset();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each([
    {
      label: 'unchanged close',
      outcome: { kind: 'close', code: 0, signal: null } satisfies EditorOutcome,
    },
    {
      label: 'spawn error',
      outcome: { kind: 'error', error: new Error('spawn failed') } satisfies EditorOutcome,
    },
    {
      label: 'SIGINT without changes',
      outcome: { kind: 'close', code: null, signal: 'SIGINT' } satisfies EditorOutcome,
    },
    {
      label: 'signal without changes',
      outcome: { kind: 'close', code: null, signal: 'SIGTERM' } satisfies EditorOutcome,
    },
    {
      label: 'non-zero exit without changes',
      outcome: { kind: 'close', code: 1, signal: null } satisfies EditorOutcome,
    },
  ])('does not overwrite newer feedback after a stale $label', async ({ outcome }) => {
    const reviewFile = join(tempDir, 'plan.json');
    const newerReviewFile = join(tempDir, 'newer.md');
    writeFileSync(reviewFile, '# spec\n');
    writeFileSync(newerReviewFile, '# newer\n');
    reviewStore.setReviewFile(reviewFile);

    const child = new EventEmitter();
    const spawnEditor: SpawnEditor = () => {
      queueMicrotask(() => {
        reviewStore.setReviewFile(newerReviewFile);
        feedbackStore.setMessage('new-owner feedback');
        if (outcome.kind === 'error') {
          child.emit('error', outcome.error);
        } else {
          child.emit('close', outcome.code, outcome.signal);
        }
      });
      return child;
    };

    await openReviewFileExternally(makeInputMode(), spawnEditor);

    expect(feedbackStore.get()).toEqual({
      message: 'new-owner feedback',
      severity: 'info',
    });
  });

  it('settles the card with the in-app edit an untouched external editor leaves on disk', async () => {
    const planMd = join(tempDir, 'plan.md');
    writeFileSync(planMd, 'Greet people by name\n');
    // The overlay saved its buffer to plan.json before it handed over to the external editor.
    writeFileSync(join(tempDir, 'plan.json'), '{"edited":true}\n');
    reviewStore.setReviewFile(planMd);
    const child = new EventEmitter();
    const spawnEditor: SpawnEditor = () => {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };
    const inputMode = makeInputMode();

    await openReviewFileExternally(inputMode, spawnEditor, '{"compiled":true}\n');

    expect(inputMode.resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
  });

  it('erases the wrapped waiting line after the editor closes and before the TUI takes the screen back', async () => {
    setActiveTerminalHandover({
      fullscreen: true,
      mouse: false,
      sourceStdin: { isRaw: false, pause: vi.fn(), resume: vi.fn() },
    });
    const planMd = join(tempDir, 'plan.md');
    writeFileSync(planMd, 'Greet people by name\n');
    reviewStore.setReviewFile(planMd);
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
    const child = new EventEmitter();
    const spawnEditor: SpawnEditor = () => {
      queueMicrotask(() => {
        output.push('<editor closed>');
        child.emit('close', 0, null);
      });
      return child;
    };

    try {
      await openReviewFileExternally(makeInputMode(), spawnEditor);
    } finally {
      if (columns) Object.defineProperty(process.stdout, 'columns', columns);
      else Reflect.deleteProperty(process.stdout, 'columns');
      vi.restoreAllMocks();
    }

    // "plan.json open in vim. Close the file to return." wraps: 2 rows at 40 columns.
    const written = output.join('');
    const erase = '\u001b[3A\r\u001b[J';
    expect(written).toContain('\r\nplan.json open in vim. Close the file to return.\n');
    expect(written.indexOf('<editor closed>')).toBeLessThan(written.indexOf(erase));
    expect(written.indexOf(erase)).toBeLessThan(written.indexOf(terminalSequences.enterAltBuffer));
  });

  it.each([
    { command: 'more', kind: 'pager', message: 'run.patch open in more. Press q to return.' },
    { command: 'ed', kind: 'editor', message: 'run.patch open in ed. Close the file to return.' },
  ] as const)(
    'leaves the waiting line of $command, which writes on the shell screen',
    async ({ command, kind, message }) => {
      const output: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      const child = new EventEmitter();
      const spawnEditor: SpawnEditor = () => {
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      };

      try {
        await runEditor({
          command,
          args: [],
          kind,
          filePath: join(tempDir, 'run.patch'),
          spawnEditor,
        });
      } finally {
        vi.restoreAllMocks();
      }

      const written = output.join('');
      expect(written).toContain(`\r\n${message}\n`);
      expect(written).not.toContain(terminalSequences.eraseDown);
    },
  );

  it('settles the card with the in-app edit when the external editor fails to start', async () => {
    const planMd = join(tempDir, 'plan.md');
    writeFileSync(planMd, 'Greet people by name\n');
    writeFileSync(join(tempDir, 'plan.json'), '{"edited":true}\n');
    reviewStore.setReviewFile(planMd);
    const child = new EventEmitter();
    const spawnEditor: SpawnEditor = () => {
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    };
    const inputMode = makeInputMode();

    await openReviewFileExternally(inputMode, spawnEditor, '{"compiled":true}\n');

    expect(inputMode.resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
  });
});
