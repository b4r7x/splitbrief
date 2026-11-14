import { describe, expect, it } from 'vitest';
import { deriveHomeComposerHint } from './hint.js';

const DEFAULT_HOME_HINT = '/help · /crew · /settings · /skills · ctrl+k commands';
const HOME_HINT = '/help · /crew · /settings · /skills · ctrl+r recent · ctrl+k commands';
const RECENT_SESSIONS_HINT = '↑↓ select · ⏎ open · y copy · esc back';

const AT_REST = {
  interactionBlocked: false,
  canFocus: false,
  sessionsActive: false,
  hintNotice: false,
  toolCheck: null,
  refreshFrame: '⠋',
} as const;

describe('deriveHomeComposerHint', () => {
  it('leaves the hint line empty while an overlay or the preparation panel takes the keys', () => {
    expect(
      deriveHomeComposerHint({
        ...AT_REST,
        interactionBlocked: true,
        canFocus: true,
        sessionsActive: true,
        hintNotice: true,
        toolCheck: 'failed',
      }),
    ).toEqual({ homeHint: undefined, homeNotice: undefined });
  });

  it('offers ctrl+r only when the recent sessions can take focus', () => {
    expect(deriveHomeComposerHint(AT_REST).homeHint).toBe(DEFAULT_HOME_HINT);
    expect(deriveHomeComposerHint({ ...AT_REST, canFocus: true }).homeHint).toBe(HOME_HINT);
  });

  it('shows the list keys and no tool check while the recent sessions have focus', () => {
    expect(
      deriveHomeComposerHint({
        ...AT_REST,
        canFocus: true,
        sessionsActive: true,
        hintNotice: true,
        toolCheck: 'failed',
      }),
    ).toEqual({ homeHint: RECENT_SESSIONS_HINT, homeNotice: undefined });
  });

  it('keeps a tool check that shows in its box off the hint line', () => {
    expect(deriveHomeComposerHint({ ...AT_REST, toolCheck: 'cold' })).toEqual({
      homeHint: DEFAULT_HOME_HINT,
      homeNotice: undefined,
    });
  });

  it('names a failed first check in the error tone and a check that did not run as a warning', () => {
    expect(deriveHomeComposerHint({ ...AT_REST, hintNotice: true, toolCheck: 'failed' })).toEqual({
      homeHint: DEFAULT_HOME_HINT,
      homeNotice: { text: 'Tool check failed · open /settings to retry', tone: 'error' },
    });
    expect(
      deriveHomeComposerHint({ ...AT_REST, hintNotice: true, toolCheck: 'not-run' }).homeNotice,
    ).toEqual({ text: 'Tools not checked · open /settings to retry', tone: 'warning' });
  });

  it('spins the frame before the title of a cold or a warm check', () => {
    expect(
      deriveHomeComposerHint({ ...AT_REST, hintNotice: true, toolCheck: 'cold' }).homeNotice,
    ).toEqual({ text: '⠋ Checking your tools…', tone: 'textDim' });
    expect(
      deriveHomeComposerHint({
        ...AT_REST,
        canFocus: true,
        hintNotice: true,
        toolCheck: 'warm',
        refreshFrame: '⠙',
      }),
    ).toEqual({
      homeHint: HOME_HINT,
      homeNotice: { text: '⠙ Refreshing your tools…', tone: 'textDim' },
    });
  });
});
