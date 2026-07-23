import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { feedbackStore } from '../../../src/stores/ui/feedback.js';
import { terminalSizeStore } from '../../../src/stores/ui/terminal-size.js';
import { Composer } from '../../../src/components/composer/composer.js';
import { COMMANDS, renderDockedComposer } from '#testing/helpers/composer.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

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

describe('Composer home feedback sanitization', () => {
  beforeEach(() => {
    resetAllStores();
    terminalSizeStore.__testReset({ cols: 80, rows: 24, isSmall: false });
  });

  afterEach(() => {
    resetAllStores();
  });

  it('strips OSC/CSI control bytes from home attachment feedback while keeping the stored message raw', async () => {
    const rawMessage = `Attached: ${ESC}[2J${ESC}]0;LEAKTITLE${BEL}/tmp/screenshot.png`;
    feedbackStore.setMessage(rawMessage);

    const ui = renderFeature(
      <Composer
        commands={[]}
        currentScreen="home"
        mode="normal"
        hint=""
        homeHint="Ready to plan"
        onSubmit={() => {}}
        onRuntimeCommand={() => {}}
      />,
    );
    await tick(20);

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain(`${ESC}]0;`);
    expect(frame).not.toContain(`${ESC}[2J`);
    const visible = stripAnsiStyles(frame);
    expect(visible).not.toContain('LEAKTITLE');
    expect(visible).toContain('screenshot.png');
    expect(feedbackStore.get().message).toBe(rawMessage);
    ui.unmount();
  });
});
