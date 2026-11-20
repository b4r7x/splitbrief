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
    ).toEqual({ homeHint: undefined, homeNotice: undefined, standingNotice: undefined });
  });

  it('offers ctrl+r only when the recent sessions can take focus', () => {
    expect(deriveHomeComposerHint(AT_REST).homeHint).toBe(DEFAULT_HOME_HINT);
    expect(deriveHomeComposerHint({ ...AT_REST, canFocus: true }).homeHint).toBe(HOME_HINT);
  });

  it('keeps the failed check and the list keys while the recent sessions have focus', () => {
    expect(
      deriveHomeComposerHint({
        ...AT_REST,
        canFocus: true,
        sessionsActive: true,
        hintNotice: true,
        toolCheck: 'failed',
      }),
    ).toEqual({
      homeHint: RECENT_SESSIONS_HINT,
      homeNotice: undefined,
      standingNotice: { message: 'Tool check failed · open /settings to retry', severity: 'error' },
    });
  });

  it('keeps a tool check that shows in its box off the hint line', () => {
    expect(deriveHomeComposerHint({ ...AT_REST, toolCheck: 'cold' })).toEqual({
      homeHint: DEFAULT_HOME_HINT,
      homeNotice: undefined,
      standingNotice: undefined,
    });
  });

  it('stands a failed first check in the notice slot as an error and one that did not run as a warning', () => {
    expect(deriveHomeComposerHint({ ...AT_REST, toolCheck: 'failed' })).toEqual({
      homeHint: DEFAULT_HOME_HINT,
      homeNotice: undefined,
      standingNotice: { message: 'Tool check failed · open /settings to retry', severity: 'error' },
    });
    expect(deriveHomeComposerHint({ ...AT_REST, toolCheck: 'not-run' }).standingNotice).toEqual({
      message: 'Tools not checked · open /settings to retry',
      severity: 'warning',
    });
  });

  it('spins the frame before the title of a cold or a warm check', () => {
    expect(
      deriveHomeComposerHint({ ...AT_REST, hintNotice: true, toolCheck: 'cold' }).homeNotice,
    ).toBe('⠋ Checking your tools…');
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
      homeNotice: '⠙ Refreshing your tools…',
      standingNotice: undefined,
    });
  });
});
