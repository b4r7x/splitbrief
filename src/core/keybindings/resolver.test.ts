import { describe, expect, it } from 'vitest';
import type { OverlayType, Screen, InputMode } from '../navigation/types.js';
import { normalizeKeySignature, type KeyLike } from './normalize.js';
import {
  resolveKeyOwner,
  type FocusedKeySurface,
  type KeyAttachState,
  type KeyOwner,
} from './resolver.js';

interface MatrixCase {
  name: string;
  input: string;
  key: KeyLike;
  screen?: Screen | undefined;
  inputMode?: InputMode | undefined;
  focus?: FocusedKeySurface | undefined;
  overlay?: OverlayType | undefined;
  attachState?: KeyAttachState | undefined;
  composerFocus?: boolean | undefined;
  expected: KeyOwner['owner'] | null;
  action?: KeyOwner['action'] | undefined;
}

function ownerFor(testCase: MatrixCase): KeyOwner | null {
  return resolveKeyOwner({
    screen: testCase.screen ?? 'workflow',
    inputMode: testCase.inputMode ?? 'normal',
    focus: testCase.focus ?? 'workflow',
    overlay: testCase.overlay ?? 'none',
    attachState: testCase.attachState ?? 'local',
    composerFocus: testCase.composerFocus ?? false,
    key: normalizeKeySignature({ input: testCase.input, key: testCase.key }),
  });
}

describe('resolveKeyOwner', () => {
  it.each<MatrixCase>([
    {
      name: 'workflow Ctrl+A toggles activity with normal composer focus',
      input: 'a',
      key: { ctrl: true },
      composerFocus: true,
      expected: 'workflow',
      action: 'toggle-activity',
    },
    {
      name: 'workflow Ctrl+E has no sidebar shortcut',
      input: 'e',
      key: { ctrl: true },
      expected: null,
    },
    {
      name: 'composer editing chord routes to text-editing owner',
      input: 'e',
      key: { ctrl: true },
      composerFocus: true,
      expected: 'text-editing',
      action: 'move-line-end',
    },
    {
      name: 'workflow Alt+A is not an activity shortcut',
      input: 'a',
      key: { meta: true },
      composerFocus: true,
      expected: null,
    },
    {
      name: 'workflow Meta+A is not an activity shortcut',
      input: 'a',
      key: { super: true },
      composerFocus: true,
      expected: null,
    },
    {
      name: 'local Ctrl+D',
      input: 'd',
      key: { ctrl: true },
      expected: 'workflow',
      action: 'toggle-diff',
    },
    {
      name: 'attached Ctrl+D',
      input: 'd',
      key: { ctrl: true },
      attachState: 'attached',
      expected: 'attached-client',
      action: 'detach',
    },
    {
      name: 'review PageDown',
      input: '',
      key: { pageDown: true },
      inputMode: 'review',
      focus: 'review',
      expected: 'review',
      action: 'scroll',
    },
    {
      name: 'workflow Shift+Down',
      input: '',
      key: { shift: true, downArrow: true },
      expected: 'conversation-scroll',
      action: 'scroll',
    },
    {
      name: 'overlay escape',
      input: '',
      key: { escape: true },
      overlay: 'settings',
      expected: 'overlay',
      action: 'close',
    },
    {
      name: 'plain composer text',
      input: 'x',
      key: {},
      composerFocus: true,
      expected: null,
    },
  ])('$name has one owner', (testCase) => {
    const owner = ownerFor(testCase);
    expect(owner?.owner ?? null).toBe(testCase.expected);
    if (testCase.action !== undefined) expect(owner?.action).toBe(testCase.action);
  });
});
