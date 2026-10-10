import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { renderDockedComposer } from '#testing/helpers/composer.js';
import { cleanupTempDir, createTempDir, normalizeMacTmpPath } from '#testing/helpers/temp-dir.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { glyph } from '../../lib/glyphs.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { getInputHistoryDocuments, inputHistoryStore } from '../../stores/ui/input-history.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { tokensStore } from '../../stores/workflow/tokens.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { COMMANDS_ONLY_NOTICE, Composer } from './composer.js';

describe('Composer blocking-question isolation', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it('never loads normal composer history into a blocking question', async () => {
    inputHistoryStore.hydrate(['NORMAL_HISTORY_SENTINEL']);
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode="question"
        hint="Blocking question"
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();

    ui.stdin.write('\x1b[A');
    await flushEffects();
    ui.stdin.write('\x1b[B');
    await flushEffects();

    expect(ui.lastFrame()).not.toContain('NORMAL_HISTORY_SENTINEL');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(submissions).toEqual(['']);
    ui.unmount();
  });

  it('keeps an unfinished answer as the unsent draft when the mode flips back to normal', async () => {
    const submissions: string[] = [];
    const composer = (mode: 'normal' | 'question') => (
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode={mode}
        hint=""
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />
    );
    const ui = renderFeature(composer('question'));
    await flushEffects();
    ui.stdin.write('unfinished answer');
    await flushEffects();
    expect(ui.lastFrame()).toContain('unfinished answer');

    ui.rerender(composer('normal'));
    await flushEffects();
    // The flip neither clears the draft nor submits it as an answer: the text stays put, unsent.
    expect(ui.lastFrame()).toContain('unfinished answer');
    expect(submissions).toEqual([]);

    // A bare Enter submits it once, as the normal instruction it now sits in — visibly, not silently.
    ui.stdin.write('\r');
    await flushEffects();
    expect(submissions).toEqual(['unfinished answer']);
    expect(ui.lastFrame()).not.toContain('unfinished answer');
    ui.unmount();
  });
});

describe('Composer submit draft retention', () => {
  const COMMANDS: RuntimeCommandDef[] = [
    {
      kind: 'arg',
      name: '/sample',
      label: 'Sample',
      description: 'Sample command',
      category: 'navigate',
      args: { kind: 'free', hint: '<text>' },
      validScreens: ['home'],
      handler: () => {},
    },
  ];

  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it('preserves a burst of separate character events before submitting', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    const text = 'headless composer input λ漢字';
    for (const character of text) ui.stdin.write(character);
    await flushEffects();
    expect(ui.lastFrame()).toContain(text);
    ui.stdin.write('\r');
    await flushEffects();
    expect(submissions).toEqual([text]);
    ui.unmount();
  });

  it('clears the submitted draft by default', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('cleared feature');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual(['cleared feature']);
    expect(ui.lastFrame()).not.toContain('cleared feature');
    ui.unmount();
  });

  it('keeps the submitted draft when submitKeepsDraft is set', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        submitKeepsDraft
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('kept feature');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual(['kept feature']);
    expect(ui.lastFrame()).toContain('kept feature');
    ui.unmount();
  });

  it('still clears a runtime command when submitKeepsDraft is set', async () => {
    const dispatched: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={COMMANDS}
        currentScreen="home"
        mode="normal"
        hint=""
        submitKeepsDraft
        onSubmit={() => {}}
        onRuntimeCommand={(command) => dispatched.push(command)}
      />,
    );
    await flushEffects();
    ui.stdin.write('/sample quick');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(dispatched).toEqual(['/sample quick']);
    expect(ui.lastFrame()).not.toContain('/sample quick');
    ui.unmount();
  });

  it('renders the supplied prompt glyph in place of the default marker', async () => {
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        promptGlyph="⠋"
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();

    expect(ui.lastFrame()).toContain('⠋');
    ui.unmount();
  });
});

describe('Composer submit trimming', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it('trims leading and trailing whitespace from a submitted draft', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('  padded feature  ');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual(['padded feature']);
    expect(getInputHistoryDocuments(inputHistoryStore.get(), { currentScreen: 'home' })).toEqual([
      createDraftDocument('padded feature'),
    ]);
    ui.unmount();
  });

  it('trims a question answer at the submit boundary', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode="question"
        hint="Blocking question"
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('  spaced answer  ');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual(['spaced answer']);
    ui.unmount();
  });

  it('keeps interior blank lines while trimming the ends', async () => {
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    composerDraftStore.requestDocument(
      createDraftDocument('  fix the parser\n\nthen the tests\n\n'),
    );
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual(['fix the parser\n\nthen the tests']);
    ui.unmount();
  });
});

describe('Composer image attach gate', () => {
  const HOME_HINT = 'home hint';
  let projectDir: string;
  let imagePath: string;

  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 120, rows: 40 });
    projectDir = createTempDir('composer-attach');
    imagePath = join(projectDir, 'shot.png');
    writeFileSync(imagePath, 'png-bytes');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  function renderComposer() {
    return renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint={HOME_HINT}
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
    );
  }

  async function dropImage(ui: ReturnType<typeof renderFeature>) {
    ui.stdin.write(`"${imagePath}"`);
    await flushEffects();
  }

  it('refuses the drop and names the plan seat when the planner cannot see images', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'shell', command: 'my-planner' } }),
    });
    const ui = renderComposer();
    await flushEffects();
    await dropImage(ui);

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('/crew plan');
    expect(attachmentsStore.peek()).toEqual([]);
    ui.unmount();
  });

  it('keeps the /crew plan remedy visible when the refusal is ellipsized at 60x18', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          model: 'house-brand-text-only-extended-preview',
          apiBase: 'https://api.example.test/v1',
        },
      }),
    });
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint={HOME_HINT}
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
      { cols: 60, rows: 18 },
    );
    await flushEffects();
    await dropImage(ui);

    const rows = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const remedyRow = rows.find((row) => row.includes('/crew plan'));
    expect(remedyRow).toBeDefined();
    expect(getTerminalCellWidth(remedyRow ?? '')).toBeLessThanOrEqual(60);
    expect(attachmentsStore.peek()).toEqual([]);
    ui.unmount();
  });

  it('puts the dropped image in the draft as an atom the plan seat can see', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const ui = renderComposer();
    await flushEffects();
    await dropImage(ui);

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('[image #1]');
    // Nothing is pending until the draft is sent: the document is where the image lives.
    expect(attachmentsStore.peek()).toEqual([]);
    ui.unmount();
  });

  it('applies an /image insertion at the caret and preserves submission order', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint={HOME_HINT}
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('A');
    await flushEffects();

    composerDraftStore.requestImage({
      id: 'command-image',
      kind: 'image',
      path: imagePath,
      mimeType: 'image/png',
      sizeBytes: 9,
    });
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('A[image #1]');
    expect(attachmentsStore.peek()).toEqual([]);

    ui.stdin.write('B');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(attachmentsStore.peek().map((attachment) => attachment.id)).toEqual(['command-image']);
    expect(submissions[0]).toMatch(/^A\[image:command-image\]B/);
    ui.unmount();
  });

  it('submits a draft starting with an image before /help instead of running a command', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const submissions: string[] = [];
    const dispatched: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint={HOME_HINT}
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={(command) => dispatched.push(command)}
      />,
    );
    await flushEffects();
    composerDraftStore.requestDocument({
      version: 1,
      parts: [
        {
          kind: 'image',
          attachment: {
            id: 'command-image',
            kind: 'image',
            path: imagePath,
            mimeType: 'image/png',
            sizeBytes: 9,
          },
        },
        { kind: 'text', text: '/help' },
      ],
    });
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual([expect.stringMatching(/^\[image:command-image\]\/help\n\n/)]);
    expect(dispatched).toEqual([]);
    expect(attachmentsStore.peek().map((attachment) => attachment.id)).toEqual(['command-image']);
    ui.unmount();
  });

  it('sends the images of the draft in document order, around their text', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const second = join(projectDir, 'second.png');
    writeFileSync(second, 'png-bytes');
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint={HOME_HINT}
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('A');
    await flushEffects();
    await dropImage(ui);
    ui.stdin.write('B');
    await flushEffects();
    ui.stdin.write(`"${second}"`);
    await flushEffects();
    ui.stdin.write('C');
    await flushEffects();

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('A[image #1]B[image #2]C');

    ui.stdin.write('\r');
    await flushEffects();

    expect(attachmentsStore.peek().map((a) => normalizeMacTmpPath(a.path))).toEqual([
      normalizeMacTmpPath(imagePath),
      normalizeMacTmpPath(second),
    ]);
    const sent = submissions[0] ?? '';
    const [firstRef, secondRef] = attachmentsStore.peek().map((a) => `[image:${a.id}]`);
    expect(sent.startsWith(`A${firstRef}B${secondRef}C`)).toBe(true);
    expect(sent).toContain(`${firstRef} = attached image 1`);
    expect(sent).toContain(`${secondRef} = attached image 2`);
    ui.unmount();
  });

  it('drops the image where the caret is, not at the end of the draft', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const ui = renderComposer();
    await flushEffects();
    ui.stdin.write('AB');
    await flushEffects();
    ui.stdin.write('\x1b[D');
    await flushEffects();
    await dropImage(ui);
    ui.stdin.write('X');
    await flushEffects();

    // The atom went in at the caret, and the caret came out on its far side — `B` still trails it
    // (the rendered caret cell sits between `X` and `B`).
    const line = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(line).toContain('A[image #1]X');
    expect(line).toMatch(/A\[image #1\]X\s?B/);
    ui.unmount();
  });

  it('does not reuse the drop caret when history recalls the next draft', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    inputHistoryStore.hydrate(['an earlier prompt']);
    const ui = renderComposer();
    await flushEffects();
    ui.stdin.write('AB');
    await flushEffects();
    ui.stdin.write('\x1b[D');
    await flushEffects();
    await dropImage(ui);

    ui.stdin.write('\x1b[A');
    await flushEffects();
    ui.stdin.write('!');
    await vi.waitFor(() => {
      expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('an earlier prompt!');
    });
    ui.unmount();
  });

  it('removes exactly the image whose atom backspace took, and keeps the other', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const second = join(projectDir, 'second.png');
    writeFileSync(second, 'png-bytes');
    const ui = renderComposer();
    await flushEffects();
    await dropImage(ui);
    ui.stdin.write(`"${second}"`);
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('[image #1][image #2]');

    // The caret sits after the second atom: one backspace takes all of it and nothing else.
    ui.stdin.write('\x7f');
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('[image #1]');
    expect(frame).not.toContain('[image #2]');

    ui.stdin.write('\r');
    await flushEffects();
    expect(attachmentsStore.peek().map((a) => normalizeMacTmpPath(a.path))).toEqual([
      normalizeMacTmpPath(imagePath),
    ]);
    ui.unmount();
  });

  it('recalls the pasted text and its image after the screen has come and gone', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const submissions: string[] = [];
    const home = () => (
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint={HOME_HINT}
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />
    );

    const first = renderFeature(home());
    await flushEffects();
    first.stdin.write('line 1\nline 2\nline 3\nline 4\nline 5');
    await flushEffects();
    await dropImage(first);
    first.stdin.write(' look');
    await flushEffects();
    expect(stripAnsiStyles(first.lastFrame() ?? '')).toContain('[paste #1 +5 lines]');
    first.stdin.write('\r');
    await flushEffects();
    first.unmount();

    // The workflow screen takes over and the home composer is unmounted with it.
    const away = renderFeature(
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode="normal"
        hint=""
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    away.unmount();

    const second = renderFeature(home());
    await flushEffects();
    second.stdin.write('\x1b[A');
    await flushEffects();

    const frame = stripAnsiStyles(second.lastFrame() ?? '');
    expect(frame).toContain('line 5');
    expect(frame).toContain('[image #1]');
    expect(frame).not.toContain('[paste');

    second.stdin.write('\r');
    await flushEffects();
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toBe(submissions[0]);
    expect(submissions[1]).toContain('line 1\nline 2\nline 3\nline 4\nline 5');
    expect(submissions[1]).not.toContain('[paste');
    second.unmount();
  });

  it('leaves no collapsed-paste marker over the draft history recalls next', async () => {
    const RECALLED = 'rewrite the brief compiler so its header stops parsing its own body';
    inputHistoryStore.hydrate([RECALLED]);
    const ui = renderComposer();
    await flushEffects();
    ui.stdin.write('line 1\nline 2\nline 3\nline 4\nline 5');
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('[paste #1 +5 lines]');

    // The collapsed paste is one row, so the up arrow reaches the history rather than a line above.
    ui.stdin.write('\x1b[A');
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('rewrite the brief compiler');
    expect(frame).not.toContain('[paste');
    ui.unmount();
  });

  it('carries an image dropped into an answer through with that answer', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode="question"
        hint="Which panel?"
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('this one');
    await flushEffects();
    await dropImage(ui);
    ui.stdin.write('\r');
    await flushEffects();

    const parked = attachmentsStore.peek();
    expect(parked.map((a) => normalizeMacTmpPath(a.path))).toEqual([
      normalizeMacTmpPath(imagePath),
    ]);
    expect(submissions[0]).toContain(`this one[image:${parked[0]?.id}]`);
    ui.unmount();
  });

  it('leaves an image the /image command parked for the run on a text-only send', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    attachmentsStore.add({
      id: 'from-command',
      kind: 'image',
      path: imagePath,
      mimeType: 'image/png',
      sizeBytes: 1,
    });
    const ui = renderComposer();
    await flushEffects();
    ui.stdin.write('no image in this one');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(attachmentsStore.peek().map((a) => a.id)).toEqual(['from-command']);
    ui.unmount();
  });

  it('keeps the draft and its images when the seat refuses them at submit', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const submissions: string[] = [];
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint={HOME_HINT}
        onSubmit={(text) => submissions.push(text)}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    ui.stdin.write('look at this');
    await flushEffects();
    await dropImage(ui);

    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'shell', command: 'my-planner' } }),
    });
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(submissions).toEqual([]);
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('look at this[image #1]');
    expect(frame).toContain('/crew plan');
    ui.unmount();
  });

  it('refuses the drop when the only image-capable fact belongs to another provider', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'custom-endpoint',
          service: 'custom-endpoint',
          offering: 'payg',
          model: 'house-brand-1',
          apiBase: 'https://api.example.test/v1',
        },
      }),
    });
    // Detection only ever probes admitted presets, so a fact carrying the same
    // model id under a different provider is never borrowed for this seat.
    detectionStore.setDetection({
      cliTools: [],
      providers: [
        {
          provider: 'ollama',
          available: true,
          isLocal: true,
          models: [{ id: 'house-brand-1', contextLength: 8192, supportsImages: true }],
        },
      ],
    });
    const ui = renderComposer();
    await flushEffects();
    await dropImage(ui);

    expect(attachmentsStore.peek()).toEqual([]);
    ui.unmount();
  });

  it('keeps a hint wider than the 60x18 floor on one row', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    terminalSizeStore.__testReset({ cols: 60, rows: 18 });
    // 12 repeats of a 12-cell segment is 144 cells — well past the 60-cell floor,
    // so an untruncated hint would spill onto further rows.
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint={`/help ${'· /settings '.repeat(12)}`}
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
      { cols: 60, rows: 18 },
    );
    await flushEffects();

    const rows = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    expect(rows.filter((row) => row.includes('/settings')).length).toBe(1);
    ui.unmount();
  });
});

describe('Composer attachment affordances', () => {
  const BACKSPACE = '\x7f';
  const HOME_LEGEND = '/help · /crew · /settings · ctrl+k commands';

  function attachment(id: string) {
    return {
      id,
      kind: 'image' as const,
      path: `/tmp/${id}.png`,
      mimeType: 'image/png',
      sizeBytes: 1,
    };
  }

  function renderComposer(mode: 'normal' | 'review') {
    return renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode={mode}
        hint=""
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
    );
  }

  // Home's own prop shape: a live box whose `hint` is always set, so nothing about the
  // placeholder is observable here — the hint line is what the screen actually paints.
  function renderHomeComposer({ disabled }: { disabled: boolean }) {
    return renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint="Describe your feature…"
        homeHint={HOME_LEGEND}
        disabled={disabled}
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
    );
  }

  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it('offers the drop hint on the home hint line when the plan seat can see images', async () => {
    configStore.__testReset({
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const ui = renderHomeComposer({ disabled: false });
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain(`${HOME_LEGEND} · drop an image`);
    ui.unmount();
  });

  it('keeps the plain hint line when the plan seat cannot see images', async () => {
    configStore.__testReset({
      config: makeConfig({ planner: { kind: 'shell', command: 'my-planner' } }),
    });
    const ui = renderHomeComposer({ disabled: false });
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain(HOME_LEGEND);
    expect(frame).not.toContain('drop an image');
    ui.unmount();
  });

  it('drops the affordance whole rather than clipping the legend it rides', async () => {
    configStore.__testReset({
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    terminalSizeStore.__testReset({ cols: 50, rows: 18 });
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint="Describe your feature…"
        homeHint={HOME_LEGEND}
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
      { cols: 50, rows: 18 },
    );
    await flushEffects();

    const hintRow = stripAnsiStyles(ui.lastFrame() ?? '')
      .split('\n')
      .find((row) => row.includes('/help'));
    expect(hintRow?.trim()).toBe(HOME_LEGEND);
    ui.unmount();
  });

  it('drops the affordance while the box is disabled and cannot take a drop', async () => {
    configStore.__testReset({
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const ui = renderHomeComposer({ disabled: true });
    await flushEffects();

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('drop an image');
    ui.unmount();
  });

  it('paints no attachment row above the box for images the run already holds', async () => {
    attachmentsStore.add(attachment('first'));
    attachmentsStore.add(attachment('second'));
    const ui = renderComposer('normal');
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).not.toContain('first.png');
    expect(frame).not.toContain('📎');
    ui.unmount();
  });

  it('leaves the run images alone when backspace edits a non-empty draft', async () => {
    attachmentsStore.add(attachment('first'));
    attachmentsStore.add(attachment('second'));
    const ui = renderComposer('normal');
    await flushEffects();

    ui.stdin.write('sentinel');
    await flushEffects();
    ui.stdin.write(BACKSPACE);
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('sentine');
    expect(frame).not.toContain('sentinel');
    expect(attachmentsStore.get().pending.map((a) => a.id)).toEqual(['first', 'second']);
    ui.unmount();
  });

  it('takes no image off the run on backspace into an empty draft', async () => {
    attachmentsStore.add(attachment('first'));
    attachmentsStore.add(attachment('second'));
    const ui = renderComposer('normal');
    await flushEffects();

    ui.stdin.write(BACKSPACE);
    await flushEffects();

    expect(attachmentsStore.get().pending.map((a) => a.id)).toEqual(['first', 'second']);
    ui.unmount();
  });
});

describe('Composer draft requests', () => {
  const COPY: RuntimeCommandDef = {
    kind: 'arg',
    name: '/copy',
    label: 'copy',
    description: 'Copy to clipboard',
    category: 'io',
    args: { kind: 'closed', options: ['brief', 'transcript'], optional: true },
    validScreens: ['workflow'],
    handler: () => {},
  };

  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
  });

  it('prefills a requested draft and opens the completion menu for its arguments', async () => {
    const ui = renderDockedComposer({
      commands: [COPY],
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    composerDraftStore.request('/copy ');
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('/copy ');
    expect(frame).toContain('brief');
    expect(frame).toContain('transcript');
    ui.unmount();
  });

  it('applies a request published before the composer mounts and consumes it', async () => {
    composerDraftStore.request('/copy ');

    const first = renderDockedComposer({
      commands: [COPY],
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    expect(stripAnsiStyles(first.lastFrame() ?? '')).toContain('/copy ');
    expect(composerDraftStore.get().request).toBeNull();
    first.unmount();

    const second = renderDockedComposer({
      commands: [COPY],
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    expect(stripAnsiStyles(second.lastFrame() ?? '')).not.toContain('/copy');
    second.unmount();
  });
});

describe('Composer workflow width', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it.each([119, 120, 121])(
    'keeps the workflow input at full width through review transition at %i columns',
    async (cols) => {
      terminalSizeStore.__testReset({ cols, rows: 24 });
      const composer = (mode: 'normal' | 'review') => (
        <Composer
          commands={[]}
          currentScreen="workflow"
          mode={mode}
          hint=""
          onSubmit={() => {}}
          onRuntimeCommand={() => {}}
        />
      );
      const ui = renderFeature(composer('normal'), { cols, rows: 24 });
      await flushEffects();
      const normalWidth = Math.max(
        ...(ui.lastFrame() ?? '').split('\n').map((line) => getTerminalCellWidth(line)),
      );

      ui.rerender(composer('review'));
      await flushEffects();
      const reviewWidth = Math.max(
        ...(ui.lastFrame() ?? '').split('\n').map((line) => getTerminalCellWidth(line)),
      );

      expect(normalWidth).toBe(cols);
      expect(reviewWidth).toBe(cols);
      ui.unmount();
    },
  );
});
describe('Composer commands-only input', () => {
  let projectDir: string;
  let imagePath: string;

  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 100, rows: 24 });
    projectDir = createTempDir('composer-commands-only');
    imagePath = join(projectDir, 'shot.png');
    writeFileSync(imagePath, 'png-bytes');
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  function renderCommandsOnly() {
    return renderDockedComposer({
      commands: [],
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      commandsOnly: true,
      onRuntimeCommand: () => {},
    });
  }

  it('says why a typed letter goes nowhere and leaves the draft empty', async () => {
    const ui = renderCommandsOnly();
    await flushEffects();
    ui.stdin.write('z');
    await flushEffects();

    expect(feedbackStore.get().message).toBe('Only /commands here · ⏎ on an empty line goes home');
    expect(feedbackStore.get().isError).toBe(false);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('z');
    ui.unmount();
  });

  it('takes a slash and every letter typed after it', async () => {
    const ui = renderCommandsOnly();
    await flushEffects();
    ui.stdin.write('/');
    await flushEffects();
    for (const letter of ['s', 'e', 'a', 't']) {
      ui.stdin.write(letter);
      await flushEffects();
    }

    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('/seat');
    expect(feedbackStore.get().message).toBeNull();
    ui.unmount();
  });

  it('swallows a pasted line that does not open with a slash', async () => {
    const ui = renderCommandsOnly();
    await flushEffects();
    ui.stdin.write('zebra stripes');
    await flushEffects();

    expect(feedbackStore.get().message).toBe(COMMANDS_ONLY_NOTICE);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).not.toContain('zebra');
    ui.unmount();
  });

  it('refuses a prefilled draft that is not a command and keeps it for editing', async () => {
    const ui = renderCommandsOnly();
    await flushEffects();
    composerDraftStore.request('rewrite the validator');
    await flushEffects();
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('rewrite the validator');

    ui.stdin.write('\r');
    await flushEffects();

    expect(feedbackStore.get().message).toBe(COMMANDS_ONLY_NOTICE);
    expect(stripAnsiStyles(ui.lastFrame() ?? '')).toContain('rewrite the validator');
    ui.unmount();
  });

  it('attaches nothing from a dropped image while it takes commands only', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const ui = renderCommandsOnly();
    await flushEffects();
    ui.stdin.write(`"${imagePath}"`);
    await flushEffects();

    expect(attachmentsStore.peek()).toEqual([]);
    ui.unmount();
  });

  it('keeps the drop affordance off the hint line while it takes commands only', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint="/help · /settings"
        commandsOnly
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');
    expect(frame).toContain('/help · /settings');
    expect(frame).not.toContain('drop an image');
    ui.unmount();
  });
});

describe('Composer in-box hints', () => {
  function promptRow(frame: string): string | undefined {
    return stripAnsiStyles(frame)
      .split('\n')
      .find((line) => line.includes(glyph('prompt')));
  }

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    // A run whose tokens carry a price, so an amount would be painted if the box still asked for
    // one. The composer reads no usage at all: /usage is the only surface that names it.
    tokensStore.__testReset({
      tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
    });
    configStore.__testReset({
      projectDir: '/tmp/composer-hints-test',
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'custom-endpoint',
          model: 'priced-model',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'test-key',
        },
      }),
    });
    modelCacheStore.hydrateModelsDevCatalog({
      catalog: {
        vendor: {
          id: 'vendor',
          models: { 'priced-model': { id: 'priced-model', cost: { input: 1, output: 2 } } },
        },
      },
      fetchedAt: 1,
      validatedAt: 1,
    });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('paints the keys hint and no money or token total beside the caret', async () => {
    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="workflow"
        mode="normal"
        hint=""
        boxHints={{ keys: 'ctrl+d diff' }}
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
    );
    await flushEffects();
    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('ctrl+d diff');
    expect(frame).not.toContain('$');
    expect(frame).not.toContain('3.00');
    expect(frame).not.toContain('1,000,000');
    expect(frame).not.toMatch(/\btokens?\b/i);
    ui.unmount();
  });

  it('leaves the hint zone unclaimed when the box carries no keys', async () => {
    async function promptRowFor(boxHints: { keys: string } | undefined): Promise<string> {
      const ui = renderFeature(
        <Composer
          commands={[]}
          currentScreen="workflow"
          mode="normal"
          hint=""
          boxHints={boxHints}
          onSubmit={() => {}}
          onRuntimeCommand={() => {}}
        />,
      );
      await flushEffects();
      const row = promptRow(ui.lastFrame() ?? '') ?? '';
      ui.unmount();
      return row;
    }

    const hinted = await promptRowFor({ keys: 'ctrl+d diff' });
    const emptied = await promptRowFor({ keys: '' });
    const absent = await promptRowFor(undefined);

    expect(hinted).toContain('ctrl+d diff');
    // An emptied hint zone must not survive as an invisible element that still charges its margin:
    // it has to paint exactly what no hint at all paints.
    expect(emptied).toBe(absent);
    expect(emptied).not.toBe(hinted);
    expect(getTerminalCellWidth(emptied)).toBe(getTerminalCellWidth(hinted));
  });
});
