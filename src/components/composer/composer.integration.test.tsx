import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box } from 'ink';
import type { ComponentProps } from 'react';
import { Composer } from './composer.js';
import {
  compactComposerHints,
  composerHintZoneRects,
  computeComposerHintBudget,
} from './hint-zones.js';
import { flushEffects, renderFeature } from '#testing/helpers/ink.js';
import { glyph } from '../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
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
// The @-reference suggestions wait on an async project-file scan (a git ls-files attempt, then a
// readdir walk); that subprocess spawn can take multiple seconds when the box runs several vitest
// forks at once.
const FILE_SCAN_WAIT_MS = 15_000;

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
    await flushEffects();

    ui.stdin.write('/mde');
    await flushEffects();

    expect(ui.lastFrame()).toContain('/mde');

    ui.stdin.write(TAB);
    await flushEffects();

    expect(ui.lastFrame()).toContain('/mode');

    ui.stdin.write(ENTER);
    await flushEffects();

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
    await flushEffects();

    ui.stdin.write('/');
    await flushEffects();
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/mode');
    });
    ui.stdin.write(DOWN);
    await flushEffects();
    ui.stdin.write(TAB);
    await flushEffects();

    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain('/mode');
    });
    expect(ui.lastFrame()).not.toContain('/help');
    expect(commandCalls).toEqual([]);

    ui.stdin.write(ENTER);
    await flushEffects();
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

      await flushEffects();
      ui.stdin.write('@src/');
      await flushEffects();

      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('src/app.ts');
      }, FILE_SCAN_WAIT_MS);
      await flushEffects();

      ui.stdin.write(TAB);
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('@src/app.ts');
      });
      ui.stdin.write(' done');
      await flushEffects();
      ui.stdin.write(ENTER);
      await flushEffects();

      expect(submits).toEqual(['@src/app.ts done']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  }, 20_000);

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
      await flushEffects();

      ui.stdin.write('@src');
      await flushEffects();
      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('src/app.ts');
        expect(ui.lastFrame()).toContain('src/components/composer/composer.tsx');
        expect(stripAnsiStyles(ui.lastFrame() ?? '')).toMatch(
          new RegExp(`${glyph('cursor')}\\s+src/app\\.ts`),
        );
      }, FILE_SCAN_WAIT_MS);
      await flushEffects();

      ui.stdin.write(DOWN);
      await flushEffects();
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
      await flushEffects();

      expect(submits).toEqual(['@src/components/composer/composer.tsx']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  }, 20_000);

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
      await flushEffects();

      ui.stdin.write('@src');
      await flushEffects();

      await vi.waitFor(() => {
        expect(ui.lastFrame()).toContain('src/app.ts');
      }, FILE_SCAN_WAIT_MS);

      ui.stdin.write('\u001b');
      await flushEffects();

      const dismissedFrame = ui.lastFrame() ?? '';
      expect(dismissedFrame).toContain('@src');
      expect(dismissedFrame).not.toContain('src/app.ts');

      ui.stdin.write(ENTER);
      await flushEffects();

      expect(submits).toEqual(['@src']);
      ui.unmount();
    } finally {
      cleanupTempDir(projectDir);
    }
  }, 20_000);

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
    await flushEffects();

    ui.stdin.write(CTRL_E);
    await flushEffects();

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

    await flushEffects();
    ui.stdin.write('ab');
    await flushEffects();
    ui.stdin.write(CTRL_B);
    await flushEffects();
    ui.stdin.write(CTRL_E);
    await flushEffects();
    ui.stdin.write('!');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

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

    await flushEffects();
    ui.stdin.write('/tmp/path');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

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
    await flushEffects();

    ui.stdin.write(ENTER);
    await flushEffects();

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

    await flushEffects();
    ui.stdin.write('   ');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

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

      await flushEffects();
      ui.stdin.write('email user@example.com');
      await flushEffects();

      const frame = ui.lastFrame() ?? '';
      expect(frame).toContain('user@example.com');
      expect(frame).not.toContain('src/app.ts');

      ui.stdin.write(ENTER);
      await flushEffects();

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

    await flushEffects();
    ui.stdin.write('line 1\nline 2\nline 3\nline 4\nline 5');
    await flushEffects();

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

    await flushEffects();
    ui.stdin.write('alpha\nbeta\ngamma\ndelta');
    await flushEffects();
    ui.stdin.write('fix the log');
    await flushEffects();
    ui.stdin.write(ENTER);
    await flushEffects();

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
    await flushEffects();

    ui.stdin.write('hello');
    await flushEffects();

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
    await flushEffects();

    ui.stdin.write('hello');
    await flushEffects();

    expect(ui.lastFrame()).not.toContain('hello');
    ui.unmount();
  });
});

describe('composer in-box footer hints', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('renders override keys and the cost token inside the rounded box', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      boxHints: { keys: 'Ctrl+D detach', cost: '$0.03', costTone: 'text' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Ctrl+D detach');
    expect(frame).not.toContain('tab');
    expect(frame).toContain('$0.03');
    ui.unmount();
  });

  it('renders warning-toned cost beside override keys in question mode', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'question',
      hint: '',
      boxHints: { keys: 'Ctrl+D detach', cost: '$0.41', costTone: 'warning' },
      onSubmit: () => {},
      onRuntimeCommand: () => {},
    });
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Ctrl+D detach');
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
    await flushEffects();
    ui.stdin.write('stale answer');
    await flushEffects();
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
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('stale answer');

    ui.stdin.write(ENTER);
    await flushEffects();
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
    await flushEffects();

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
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Cannot resume "');
    expect(frame).toContain('": interrupted before it made progress — start it again.');
    expect(frame).toContain('…');

    ui.unmount();
  });
});

describe('composer integration: in-box hint click zones fire store actions', () => {
  beforeEach(() => {
    resetAllStores();
    _resetMouseZones();
    routerStore.init({ screen: 'workflow', feature: 'demo' });
    terminalSizeStore.__testReset({ cols: 80, rows: 20, isSmall: false });
  });

  it('clicking the cost hint opens cost-drilldown', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'normal',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      boxHints: { keys: 'Ctrl+G', cost: '$0.41' },
    });

    await flushEffects();

    // The docked composer is bottom-anchored above the one-row footer: the single-line hint row sits
    // at rows-visibleRows-1.
    const display = compactComposerHints(
      { keys: 'Ctrl+G', cost: '$0.41' },
      computeComposerHintBudget({ boxWidth: 80 }),
    );
    const rects = composerHintZoneRects({ boxLeft: 1, boxWidth: 80, hintRow: 18, display });
    const costRect = rects.find((rect) => rect.id === 'cost');
    if (!costRect) throw new Error('expected cost hint zone to be present');

    const costZone = hitTopmostZone(costRect.left, costRect.top);
    expect(costZone?.id).toBe('composer-hint-cost');
    costZone?.onClick?.();
    await flushEffects();
    expect(overlayStore.get().active).toBe('cost-drilldown');

    ui.unmount();
  });

  it('aligns the cost zone with the flush inputPaddingX=0 workflow composer hint', async () => {
    const cost = '$0.41';
    const ui = renderFeature(
      <Box flexDirection="column" height={20} justifyContent="flex-end" width={80}>
        <Composer
          commands={COMMANDS}
          currentScreen="workflow"
          mode="normal"
          hint=""
          onSubmit={() => {}}
          onRuntimeCommand={() => {}}
          boxHints={{ keys: 'Ctrl+G', cost }}
          inputPaddingX={0}
        />
      </Box>,
    );

    await flushEffects();

    const lines = stripAnsiStyles(ui.lastFrame() ?? '').split('\n');
    const hintRowIndex = lines.findIndex((line) => line.includes(cost));
    if (hintRowIndex < 0) throw new Error('expected cost hint text in the rendered frame');
    const hintLine = lines[hintRowIndex];
    if (hintLine === undefined) throw new Error('expected cost hint row in the rendered frame');
    const costIndex = hintLine.indexOf(cost);
    if (costIndex < 0) throw new Error('expected cost hint column in the rendered frame');
    const actualColumn = getTerminalCellWidth(hintLine.slice(0, costIndex)) + 1;
    const hintRow = terminalSizeStore.get().rows - 2;

    expect(hitTopmostZone(actualColumn, hintRow)?.id).toBe('composer-hint-cost');
    expect(hitTopmostZone(actualColumn - 1, hintRow)?.id).not.toBe('composer-hint-cost');

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
      boxHints: { keys: 'Ctrl+G', cost: '$0.41' },
    });

    await flushEffects();

    const display = compactComposerHints(
      { keys: 'Ctrl+G', cost: '$0.41' },
      computeComposerHintBudget({ boxWidth: 36 }),
    );
    expect(display.cost).toBeUndefined();
    const rects = composerHintZoneRects({ boxLeft: 1, boxWidth: 36, hintRow: 18, display });
    expect(rects).toEqual([]);
    expect(hitTopmostZone(34, 18)).toBeUndefined();

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

  it('shifts the cost zone by boxLeftOffset so a review-column click lands on the box', async () => {
    const ui = renderDockedComposer({
      commands: COMMANDS,
      currentScreen: 'workflow',
      mode: 'review',
      hint: '',
      onSubmit: () => {},
      onRuntimeCommand: () => {},
      boxHints: { keys: 'Ctrl+G', cost: '$0.41' },
      width: REVIEW_WIDTH,
      boxLeftOffset: REVIEW_LEFT_OFFSET,
    });

    await flushEffects();

    const display = compactComposerHints(
      { keys: 'Ctrl+G', cost: '$0.41' },
      computeComposerHintBudget({ boxWidth: REVIEW_WIDTH }),
    );
    const rects = composerHintZoneRects({
      boxLeft: 1 + REVIEW_LEFT_OFFSET,
      boxWidth: REVIEW_WIDTH,
      hintRow: 18,
      display,
    });
    const costRect = rects.find((rect) => rect.id === 'cost');
    if (!costRect) throw new Error('expected inset cost hint zone to be present');

    expect(costRect.left).toBeGreaterThan(REVIEW_LEFT_OFFSET);
    expect(hitTopmostZone(costRect.left, costRect.top)?.id).toBe('composer-hint-cost');
    expect(hitTopmostZone(costRect.left - REVIEW_LEFT_OFFSET, 18)).toBeUndefined();

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
      boxHints: { keys: 'Ctrl+G', cost: '$0.41' },
      width: REVIEW_WIDTH,
    });

    await flushEffects();

    const display = compactComposerHints(
      { keys: 'Ctrl+G', cost: '$0.41' },
      computeComposerHintBudget({ boxWidth: REVIEW_WIDTH }),
    );
    const rects = composerHintZoneRects({
      boxLeft: 1 + REVIEW_LEFT_OFFSET,
      boxWidth: REVIEW_WIDTH,
      hintRow: 18,
      display,
    });
    const costRect = rects.find((rect) => rect.id === 'cost');
    if (!costRect) throw new Error('expected a cost rect for the probe');
    expect(hitTopmostZone(costRect.left, costRect.top)).toBeUndefined();

    ui.unmount();
  });
});
