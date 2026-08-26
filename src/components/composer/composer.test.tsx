import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { renderDockedComposer } from '#testing/helpers/composer.js';
import { cleanupTempDir, createTempDir, normalizeMacTmpPath } from '#testing/helpers/temp-dir.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { configStore } from '../../stores/project/config.js';
import { detectionStore } from '../../stores/project/detection.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { inputHistoryStore } from '../../stores/ui/input-history.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { Composer } from './composer.js';

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

  it('does not carry an unfinished question answer back into normal mode', async () => {
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
    expect(ui.lastFrame()).not.toContain('unfinished answer');

    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(submissions).not.toContain('unfinished answer');
    ui.unmount();
  });
});

describe('Composer submit draft retention', () => {
  const COMMANDS: RuntimeCommandDef[] = [
    {
      kind: 'arg',
      name: '/mode',
      label: 'Mode',
      description: 'Workflow mode',
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
    ui.stdin.write('/mode quick');
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();

    expect(dispatched).toEqual(['/mode quick']);
    expect(ui.lastFrame()).not.toContain('/mode quick');
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
          provider: 'openai',
          model: 'house-brand-text-only-extended-preview',
          apiBase: 'https://api.openai.com/v1',
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

  it('attaches the drop when the planner is a CLI tool', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({ planner: { kind: 'cli', tool: 'claude-code' } }),
    });
    const ui = renderComposer();
    await flushEffects();
    await dropImage(ui);

    expect(attachmentsStore.peek().map((a) => normalizeMacTmpPath(a.path))).toEqual([
      normalizeMacTmpPath(imagePath),
    ]);
    ui.unmount();
  });

  it('attaches the drop when detection says the API model sees images despite its name', async () => {
    configStore.__testReset({
      projectDir,
      config: makeConfig({
        planner: {
          kind: 'api',
          provider: 'openai',
          model: 'house-brand-1',
          apiBase: 'https://api.openai.com/v1',
        },
      }),
    });
    detectionStore.setDetection({
      cliTools: [],
      providers: [
        {
          provider: 'openai',
          available: true,
          isLocal: false,
          hasKey: true,
          models: [{ id: 'house-brand-1', contextLength: 8192, supportsImages: true }],
        },
      ],
    });
    const ui = renderComposer();
    await flushEffects();
    await dropImage(ui);

    expect(attachmentsStore.peek().map((a) => normalizeMacTmpPath(a.path))).toEqual([
      normalizeMacTmpPath(imagePath),
    ]);
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
