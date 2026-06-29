import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box } from 'ink';
import type { ComponentProps } from 'react';
import {
  Composer,
  compactComposerHints,
  composerHintSegments,
  composerHintZoneRects,
  computeComposerHintBudget,
  fitFeedbackMessage,
  renderComposerHint,
} from './composer.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { glyph } from '../../lib/glyphs.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { configStore } from '../../stores/project/config.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { focusStore } from '../../stores/ui/focus.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { hitTopmostZone, _resetMouseZones } from '../../lib/terminal/mouse-zones.js';
import { routerStore } from '../../stores/navigation/router.js';
import type { RuntimeCommandDef } from '../../core/runtime/commands/types.js';

const COMMANDS: RuntimeCommandDef[] = [
  {
    kind: 'noarg',
    name: '/help',
    label: 'Help',
    description: 'Show help',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'arg',
    name: '/mode',
    label: 'Mode',
    description: 'Workflow mode',
    validScreens: ['home'],
    handler: () => {},
  },
  {
    kind: 'noarg',
    name: '/settings',
    label: 'Settings',
    description: 'Open settings',
    validScreens: ['home'],
    handler: () => {},
  },
];

const DOWN = '\u001b[B';
const TAB = '\t';
const ENTER = '\r';
const CTRL_B = '\x02';
const CTRL_E = '\x05';

function renderDockedComposer(props: ComponentProps<typeof Composer>) {
  return renderFeature(
    <Box flexDirection="column" height={20} justifyContent="flex-end">
      <Composer {...props} />
    </Box>,
  );
}

function seedProjectFiles(prefix: string, files: string[]): string {
  const projectDir = createTempDir(prefix);
  for (const file of files) {
    const directory = file.split('/').slice(0, -1).join('/');
    if (directory) {
      mkdirSync(join(projectDir, directory), { recursive: true });
    }
    writeFileSync(join(projectDir, file), '');
  }
  configStore.__testReset({ projectDir });
  return projectDir;
}

describe('composer integration: completions', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('completes a fuzzy slash command and dispatches it only after the user submits', async () => {
    const commandCalls: string[] = [];
    const submits: string[] = [];

    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      onSubmit: (t) => submits.push(t),
      onRuntimeCommand: (c) => commandCalls.push(c),
    });

    ui.stdin.write('/mde');
    await tick(20);

    expect(ui.lastFrame()).toContain('/mde');

    ui.stdin.write(TAB);
    await tick(20);

    expect(ui.lastFrame()).toContain('/mode');

    ui.stdin.write(ENTER);
    await tick(20);

    expect(commandCalls).toEqual(['/mode']);
    expect(submits).toEqual([]);

    ui.unmount();
  });

  it('fills the arrow-highlighted slash command without dispatching until submit', async () => {
    const commandCalls: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: (c) => commandCalls.push(c),
    });

    ui.stdin.write('/');
    await tick(20);
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/mode');
    });
    ui.stdin.write(DOWN);
    await tick(20);
    ui.stdin.write(TAB);
    await tick(20);

    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/mode');
    });
    expect(ui.lastFrame()).not.toContain('/help');
    expect(commandCalls).toEqual([]);

    ui.stdin.write(ENTER);
    await tick(20);
    await vi.waitFor(() => {
      expect(commandCalls).toEqual(['/mode']);
    });
    ui.unmount();
  });

  it('typing @src/ shows project file suggestions, fills the selected path, and appends later input', async () => {
    const projectDir = seedProjectFiles('composer-at-file', ['src/app.ts']);
    try {
      const submits: string[] = [];
      const ui = renderDockedComposer({
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: (t) => submits.push(t),
        onRuntimeCommand: () => {},
      });

      ui.stdin.write('@src/');
      await tick(20);

      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('src/app.ts');
      });
      await tick(20);

      ui.stdin.write(TAB);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('@src/app.ts');
      });
      ui.stdin.write(' done');
      await tick(20);
      ui.stdin.write(ENTER);
      await tick(20);

      expect(submits).toEqual(['@src/app.ts done']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('accepts the arrow-highlighted file suggestion with Enter, then submits on the next Enter', async () => {
    const projectDir = seedProjectFiles('composer-at-file-arrow', [
      'src/app.ts',
      'src/components/composer/composer.tsx',
    ]);
    try {
      const submits: string[] = [];
      const ui = renderDockedComposer({
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: (text) => submits.push(text),
        onRuntimeCommand: () => {},
      });

      ui.stdin.write('@src');
      await tick(20);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('src/app.ts');
        expect(ui.lastFrame()).toContain('src/components/composer/composer.tsx');
        expect(stripAnsiStyles(ui.lastFrame() ?? '')).toMatch(
          new RegExp(`${glyph('cursor')}\\s+src/app\\.ts`),
        );
      });
      await tick(20);

      ui.stdin.write(DOWN);
      await tick(20);
      await vi.waitFor(() => {
        expect(stripAnsiStyles(ui.lastFrame() ?? '')).toMatch(
          new RegExp(`${glyph('cursor')}\\s+src/components/composer/composer\\.tsx`),
        );
      });
      ui.stdin.write(ENTER);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('@src/components/composer/composer.tsx');
      });
      expect(submits).toEqual([]);

      ui.stdin.write(ENTER);
      await tick(20);

      expect(submits).toEqual(['@src/components/composer/composer.tsx']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('Escape dismisses file suggestions without clearing the typed reference', async () => {
    const projectDir = seedProjectFiles('composer-at-file-escape', ['src/app.ts']);
    try {
      const submits: string[] = [];
      const ui = renderDockedComposer({
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: (text) => submits.push(text),
        onRuntimeCommand: () => {},
      });

      ui.stdin.write('@src');
      await tick(20);

      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('src/app.ts');
      });

      ui.stdin.write('\u001b');
      await tick(20);

      const dismissedFrame = ui.lastFrame() ?? '';
      expect(dismissedFrame).toContain('@src');
      expect(dismissedFrame).not.toContain('src/app.ts');

      ui.stdin.write(ENTER);
      await tick(20);

      expect(submits).toEqual(['@src']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('routes Ctrl+E to the review edit shortcut only in review mode', async () => {
    const edit = vi.fn();
    const submits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'review',
      hint: 'approve | Ctrl+E/e edit',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
      onEditShortcut: edit,
    });

    ui.stdin.write(CTRL_E);
    await tick(20);

    expect(edit).toHaveBeenCalledTimes(1);
    expect(submits).toEqual([]);

    ui.unmount();
  });

  it('keeps Ctrl+E as text editing in normal mode even when an edit shortcut callback exists', async () => {
    const edit = vi.fn();
    const submits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
      onEditShortcut: edit,
    });

    ui.stdin.write('ab');
    await tick(20);
    ui.stdin.write(CTRL_B);
    await tick(20);
    ui.stdin.write(CTRL_E);
    await tick(20);
    ui.stdin.write('!');
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);

    expect(edit).not.toHaveBeenCalled();
    expect(submits).toEqual(['ab!']);

    ui.unmount();
  });

  it('routes slash-prefixed question answers to the prompt instead of runtime commands', async () => {
    const submits: string[] = [];
    const commandCalls: string[] = [];
    const commands: RuntimeCommandDef[] = [
      {
        kind: 'noarg',
        name: '/tmp/path',
        label: 'Tmp path',
        description: 'Test path-shaped command',
        validScreens: ['workflow'],
        handler: () => {},
      },
    ];
    const ui = renderDockedComposer({
      commands,
      currentScreen: 'workflow',
      mode: 'question',
      hint: 'Question 1/1: path?',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: (command) => commandCalls.push(command),
    });

    ui.stdin.write('/tmp/path');
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);

    expect(submits).toEqual(['/tmp/path']);
    expect(commandCalls).toEqual([]);

    ui.unmount();
  });

  it('routes an empty question answer so continuation can use its default retry path', async () => {
    const submits: string[] = [];
    const emptySubmits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: 'Task interrupted. Enter instructions to continue (or press Enter to retry):',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
      onEmptySubmit: () => emptySubmits.push('empty'),
    });

    ui.stdin.write(ENTER);
    await tick(20);

    expect(submits).toEqual(['']);
    expect(emptySubmits).toEqual([]);

    ui.unmount();
  });

  it('routes whitespace-only question answers so recovery prompts can pause', async () => {
    const submits: string[] = [];
    const emptySubmits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: 'Recovery needed',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
      onEmptySubmit: () => emptySubmits.push('empty'),
    });

    ui.stdin.write('   ');
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);

    expect(submits).toEqual(['   ']);
    expect(emptySubmits).toEqual([]);

    ui.unmount();
  });

  it('treats @ inside a word as plain text instead of opening file suggestions', async () => {
    const projectDir = seedProjectFiles('composer-at-file-boundary', ['src/app.ts']);
    try {
      const submits: string[] = [];
      const ui = renderDockedComposer({
        commands: COMMANDS,
        currentScreen: 'home',
        mode: 'normal',
        hint: '',
        onSubmit: (text) => submits.push(text),
        onRuntimeCommand: () => {},
      });

      ui.stdin.write('email user@example.com');
      await tick(20);

      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('user@example.com');
      expect(frame).not.toContain('src/app.ts');

      ui.stdin.write(ENTER);
      await tick(20);

      expect(submits).toEqual(['email user@example.com']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});

describe('composer paste capture', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('collapses a big multi-line paste to a dim marker instead of filling the field', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });

    ui.stdin.write('line 1\nline 2\nline 3\nline 4\nline 5');
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('[paste #1 +5 lines]');
    expect(frame).not.toContain('line 5');

    ui.unmount();
  });

  it('submits the typed text with the captured paste body appended', async () => {
    const submits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
    });

    ui.stdin.write('alpha\nbeta\ngamma\ndelta');
    await tick(20);
    ui.stdin.write('fix the log');
    await tick(20);
    ui.stdin.write(ENTER);
    await tick(20);

    expect(submits).toEqual(['fix the log\n\nalpha\nbeta\ngamma\ndelta']);
    ui.unmount();
  });
});

describe('composer row-focus hand-off', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('types into the field when no row focus is held', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });

    ui.stdin.write('hello');
    await tick(20);

    expect(ui.lastFrame()).toContain('hello');
    ui.unmount();
  });

  it('yields the text field while a workflow row focus is held', async () => {
    focusStore.set('brief', 0);

    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });

    ui.stdin.write('hello');
    await tick(20);

    expect(ui.lastFrame()).not.toContain('hello');
    ui.unmount();
  });
});

describe('composer in-box footer hints', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('renders the dim submit affordance and the cost token inside the rounded box', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      boxHints: { keys: '⏎', cost: '$0.03', costTone: 'text' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('⏎');
    expect(frame).not.toContain('tab');
    expect(frame).toContain('$0.03');
    ui.unmount();
  });

  it('drops tab and shows the send affordance for question-mode hints', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: '',
      boxHints: { keys: '⏎  send', cost: '$0.41', costTone: 'warning' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('send');
    expect(frame).toContain('$0.41');
    expect(frame).not.toContain('tab');
    ui.unmount();
  });

  it('clears a stale draft when questionEpoch advances in question mode', async () => {
    const submits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: 'first question',
      questionEpoch: 1,
      onSubmit: (text) => submits.push(text),
      onRuntimeCommand: () => {},
    });
    ui.stdin.write('stale answer');
    await tick(20);
    expect(ui.lastFrame()).toContain('stale answer');

    ui.rerender(
      <Box flexDirection="column" height={20} justifyContent="flex-end">
        <Composer
          commands={COMMANDS}
          currentScreen="workflow"
          mode="question"
          hint="second question"
          questionEpoch={2}
          onSubmit={(text) => submits.push(text)}
          onRuntimeCommand={() => {}}
        />
      </Box>,
    );
    await tick(20);
    expect(ui.lastFrame()).not.toContain('stale answer');

    ui.stdin.write(ENTER);
    await tick(20);
    expect(submits).not.toContain('stale answer');
    ui.unmount();
  });
});

describe('composer feedback', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('preserves the failed-session suffix when the feature name contains quotes', async () => {
    feedbackStore.setError(
      'Session "alpha "quoted" name with enough text to truncate" failed without a summary to display',
    );

    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      homeHint: 'Ready',
      width: 60,
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Session "alpha');
    expect(frame).toContain('" failed without a summary to display');
    expect(frame).toContain('…');
    expect(frame).not.toContain('Ready');

    ui.unmount();
  });

  it('preserves the resume suffix for wide-character titles in rendered output', async () => {
    feedbackStore.setError(
      `Cannot resume "${'功能'.repeat(12)}": interrupted before it made progress — start it again.`,
    );

    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'home',
      mode: 'normal',
      hint: '',
      homeHint: 'Ready',
      width: 80,
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Cannot resume "');
    expect(frame).toContain('": interrupted before it made progress — start it again.');
    expect(frame).toContain('…');

    ui.unmount();
  });
});

describe('fitFeedbackMessage', () => {
  it('leaves short feedback unchanged', () => {
    expect(fitFeedbackMessage('Cannot resume "alpha": missing state', 80)).toBe(
      'Cannot resume "alpha": missing state',
    );
  });

  it('leaves normal structured feedback unchanged when it fits', () => {
    expect(
      fitFeedbackMessage(
        {
          prefix: 'Cannot resume "',
          title: 'alpha',
          suffix: '": interrupted before it made progress — start it again.',
        },
        80,
      ),
    ).toBe('Cannot resume "alpha": interrupted before it made progress — start it again.');
  });

  it('truncates the quoted session title while preserving the actionable suffix', () => {
    const fitted = fitFeedbackMessage(
      {
        prefix: 'Cannot resume "',
        title: 'prosze pokaz mi ze to dziala po prostu zrob test nic wiecej nie chce od ciebie',
        suffix: '": interrupted before it made progress — start it again.',
      },
      100,
    );

    expect(fitted.length).toBeLessThanOrEqual(100);
    expect(fitted).toContain('Cannot resume "prosze');
    expect(fitted).toContain('": interrupted before it made progress — start it again.');
    expect(fitted).toContain('…');
    expect(fitted).not.toContain('nie chce od ciebie');
  });

  it('truncates wide-character titles by display width while preserving the suffix', () => {
    const fitted = fitFeedbackMessage(
      {
        prefix: 'Session "',
        title: '功能'.repeat(8),
        suffix: '" failed without a summary to display',
      },
      55,
    );

    expect(fitted).toBe('Session "功能功能…" failed without a summary to display');
  });

  it('falls back to whole-message truncation when the suffix alone is too wide', () => {
    const fitted = fitFeedbackMessage(
      {
        prefix: 'Cannot resume "',
        title: 'very long title',
        suffix: '": interrupted before it made progress — start it again.',
      },
      24,
    );

    expect(fitted.length).toBeLessThanOrEqual(24);
    expect(fitted).toContain('…');
  });
});

describe('composer in-box hint hotspots', () => {
  it('budget shrinks linearly with box width', () => {
    expect(computeComposerHintBudget(80)).toBe(48);
    expect(computeComposerHintBudget(45)).toBe(13);
    expect(computeComposerHintBudget(40)).toBe(8);
    expect(computeComposerHintBudget(10)).toBe(0);
  });

  it('compacts the hint ladder: full → drop cost', () => {
    const hints = { keys: '⏎', cost: '$0.03' };

    expect(compactComposerHints(hints, 8)).toEqual({ keys: '⏎', cost: '$0.03' });
    expect(compactComposerHints(hints, 7)).toEqual({ keys: '⏎', cost: undefined });
  });

  it('renders the right-aligned hint with the cost trailing the keys', () => {
    expect(renderComposerHint({ keys: 'tab  ⏎', cost: '$0.03' })).toBe('tab  ⏎  $0.03');
    expect(renderComposerHint({ keys: '', cost: '$0.03' })).toBe('$0.03');
    expect(renderComposerHint({ keys: '⏎', cost: undefined })).toBe('⏎');
  });

  it('maps the submit glyph and cost token to their cell offsets', () => {
    expect(composerHintSegments({ keys: 'tab  ⏎', cost: '$0.03' })).toEqual([
      { id: 'submit', offset: 5, width: 1 },
      { id: 'cost', offset: 8, width: 5 },
    ]);
  });

  it('drops the cost zone when the cost is compacted away (no phantom hotspot)', () => {
    expect(composerHintSegments({ keys: '⏎', cost: undefined })).toEqual([
      { id: 'submit', offset: 0, width: 1 },
    ]);
  });

  it('measures segment offsets in cells so a wide-cell glyph cannot drift a zone', () => {
    // '混' is a width-2 CJK glyph but a single JS code unit; a raw character index would place the
    // submit/cost segments one cell too far left. Offsets must be the cell width of the prefix.
    const rendered = renderComposerHint({ keys: '混 ⏎', cost: '$0.03' });
    expect(rendered).toBe('混 ⏎  $0.03');
    expect(composerHintSegments({ keys: '混 ⏎', cost: '$0.03' })).toEqual([
      { id: 'submit', offset: 3, width: 1 },
      { id: 'cost', offset: 6, width: 5 },
    ]);
  });

  it('calibrates zone rects to the right edge of the box on the hint row', () => {
    const rects = composerHintZoneRects({
      boxLeft: 1,
      boxWidth: 80,
      hintRow: 22,
      display: { keys: 'tab  ⏎', cost: '$0.03' },
    });

    expect(rects).toEqual([
      { id: 'submit', left: 71, right: 71, top: 22, bottom: 22 },
      { id: 'cost', left: 74, right: 78, top: 22, bottom: 22 },
    ]);
    // the cost token ends at the last in-box cell: boxLeft + boxWidth - 3 (1 border + 1 padding).
    expect(rects[1]?.right).toBe(1 + 80 - 3);
    // calibration: a click on the hint row maps to row index 0 (sgrY - rect.top).
    expect(22 - (rects[0]?.top ?? 0)).toBe(0);
  });

  it('tracks the compacted render so a dropped hint is never clickable', () => {
    const narrow = composerHintZoneRects({
      boxLeft: 1,
      boxWidth: 40,
      hintRow: 22,
      display: compactComposerHints({ keys: '⏎', cost: '$0.03' }, computeComposerHintBudget(40)),
    });

    expect(narrow.map((rect) => rect.id)).toEqual(['submit', 'cost']);
    expect(narrow.some((rect) => rect.id === 'cost')).toBe(true);

    const veryNarrow = composerHintZoneRects({
      boxLeft: 1,
      boxWidth: 36,
      hintRow: 22,
      display: compactComposerHints({ keys: '⏎', cost: '$0.03' }, computeComposerHintBudget(36)),
    });

    expect(veryNarrow.map((rect) => rect.id)).toEqual(['submit']);
  });
});

describe('composer integration: in-box hint click zones fire store actions', () => {
  beforeEach(() => {
    resetAllStores();
    _resetMouseZones();
    routerStore.init({ screen: 'workflow', feature: 'demo' });
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: false });
  });

  it('clicking the ⏎ hint submits and clicking the cost hint opens cost-drilldown', async () => {
    const submits: string[] = [];
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: (t) => submits.push(t),
      onRuntimeCommand: () => {},
      boxHints: { keys: '⏎', cost: '$0.41' },
    });

    ui.stdin.write('ship it');
    await tick(20);

    // The docked composer is bottom-anchored above the two-row footer: the single-line hint row sits
    // at rows-visibleRows-2.
    const display = compactComposerHints(
      { keys: '⏎', cost: '$0.41' },
      computeComposerHintBudget(80),
    );
    const rects = composerHintZoneRects({ boxLeft: 1, boxWidth: 80, hintRow: 17, display });
    const submitRect = rects.find((rect) => rect.id === 'submit');
    const costRect = rects.find((rect) => rect.id === 'cost');
    if (!submitRect || !costRect) throw new Error('expected both hint zones to be present');

    const submitZone = hitTopmostZone(submitRect.left, submitRect.top);
    expect(submitZone?.id).toBe('composer-hint-submit');
    submitZone?.onClick?.();
    await tick(20);
    expect(submits).toEqual(['ship it']);

    const costZone = hitTopmostZone(costRect.left, costRect.top);
    expect(costZone?.id).toBe('composer-hint-cost');
    costZone?.onClick?.();
    await tick(20);
    expect(overlayStore.get().active).toBe('cost-drilldown');

    ui.unmount();
  });

  it('registers no cost zone when the cost is compacted away (no phantom hotspot)', async () => {
    terminalSizeStore.__testReset({ cols: 36, rows: 20, isSmall: false });
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      boxHints: { keys: '⏎', cost: '$0.41' },
    });

    await tick(20);

    const display = compactComposerHints(
      { keys: '⏎', cost: '$0.41' },
      computeComposerHintBudget(36),
    );
    expect(display.cost).toBeUndefined();
    const rects = composerHintZoneRects({ boxLeft: 1, boxWidth: 36, hintRow: 17, display });
    expect(rects.map((rect) => rect.id)).toEqual(['submit']);
    expect(hitTopmostZone(rects[0]?.left ?? 0, 17)?.id).toBe('composer-hint-submit');

    ui.unmount();
  });
});

describe('composer review-column hint zones register against the inset box', () => {
  const REVIEW_WIDTH = 50;
  const REVIEW_LEFT_OFFSET = 12;

  beforeEach(() => {
    resetAllStores();
    _resetMouseZones();
    routerStore.init({ screen: 'workflow', feature: 'demo' });
    terminalSizeStore.__testReset({ cols: 120, rows: 20, isSmall: false });
  });

  it('shifts the submit/cost zones by boxLeftOffset so a review-column click lands on the box', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'review',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      boxHints: { keys: '⏎', cost: '$0.41' },
      width: REVIEW_WIDTH,
      boxLeftOffset: REVIEW_LEFT_OFFSET,
    });

    await tick(20);

    const display = compactComposerHints(
      { keys: '⏎', cost: '$0.41' },
      computeComposerHintBudget(REVIEW_WIDTH),
    );
    const rects = composerHintZoneRects({
      boxLeft: 1 + REVIEW_LEFT_OFFSET,
      boxWidth: REVIEW_WIDTH,
      hintRow: 17,
      display,
    });
    const submitRect = rects.find((rect) => rect.id === 'submit');
    const costRect = rects.find((rect) => rect.id === 'cost');
    if (!submitRect || !costRect) throw new Error('expected both inset hint zones to be present');

    expect(submitRect.left).toBeGreaterThan(REVIEW_LEFT_OFFSET);
    expect(hitTopmostZone(submitRect.left, submitRect.top)?.id).toBe('composer-hint-submit');
    expect(hitTopmostZone(costRect.left, costRect.top)?.id).toBe('composer-hint-cost');
    // The docked full-width box would have placed the submit zone at column 1; the inset box must not.
    expect(hitTopmostZone(1, 17)).toBeUndefined();

    ui.unmount();
  });

  it('registers nothing for a width-constrained composer when boxLeftOffset is unknown', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'review',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      boxHints: { keys: '⏎', cost: '$0.41' },
      width: REVIEW_WIDTH,
    });

    await tick(20);

    const display = compactComposerHints(
      { keys: '⏎', cost: '$0.41' },
      computeComposerHintBudget(REVIEW_WIDTH),
    );
    const rects = composerHintZoneRects({
      boxLeft: 1 + REVIEW_LEFT_OFFSET,
      boxWidth: REVIEW_WIDTH,
      hintRow: 17,
      display,
    });
    const submitRect = rects.find((rect) => rect.id === 'submit');
    if (!submitRect) throw new Error('expected a submit rect for the probe');
    expect(hitTopmostZone(submitRect.left, submitRect.top)).toBeUndefined();

    ui.unmount();
  });
});
