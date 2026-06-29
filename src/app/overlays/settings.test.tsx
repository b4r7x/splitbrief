import { beforeEach, describe, expect, it } from 'vitest';
import { configStore } from '../../stores/project/config.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { SettingsOverlay } from './settings.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const RAW_TEST_COMMAND = `safe${ESC}]8;;http://evil${BEL}${ESC}[31mcmd`;

describe('SettingsOverlay edit mode', () => {
  beforeEach(() => {
    configStore.__testReset({
      projectDir: '/tmp/project',
      config: makeConfig({ validation: { testCommand: RAW_TEST_COMMAND } }),
    });
    overlayStore.reset();
    feedbackStore.reset();
    terminalSizeStore.__testReset({ cols: 100, rows: 40 });
  });

  it('strips terminal controls from the edit-buffer view while preserving the saved value', async () => {
    overlayStore.setFocus('validation.testCommand');
    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);

    ui.stdin.write(String.fromCharCode(13));
    await tick(20);

    const frame = stripAnsiStyles(ui.lastFrame() ?? '');

    expect(frame).toContain('safecmd');
    expect(frame).not.toContain('evil');
    expect(frame).not.toContain(`${ESC}]`);
    expect(frame).not.toContain(BEL);

    expect(configStore.get().config?.validation?.testCommand).toBe(RAW_TEST_COMMAND);

    ui.unmount();
  });

  it('does not toggle a setting with Space when no setting row is visible', async () => {
    terminalSizeStore.__testReset({ cols: 100, rows: 8, isSmall: false });
    overlayStore.setFocus('validation.typecheck');
    expect(configStore.get().config?.validation.typecheck).toBe(true);

    const ui = renderFeature(<SettingsOverlay />);
    await tick(20);

    ui.stdin.write(' ');
    await tick(20);

    expect(configStore.get().config?.validation.typecheck).toBe(true);
    ui.unmount();
  });
});
