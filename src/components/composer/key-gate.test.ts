import { describe, expect, it } from 'vitest';
import { makeKey } from '#testing/helpers/factories/key.js';
import { type ComposerKeyState, gateComposerKey } from './key-gate.js';

const STATE: ComposerKeyState = {
  mode: 'normal',
  hasSendNow: true,
  runActive: true,
  hasTab: true,
  completionOpen: false,
  commandsOnly: false,
  draftEmpty: true,
};

describe('gateComposerKey', () => {
  it.each([
    {
      name: 'ctrl+⏎ sends now while a run is live',
      input: '',
      key: makeKey({ return: true, ctrl: true }),
      state: {},
      expected: 'send-now',
    },
    {
      name: 'ctrl+⏎ is input when no run is live',
      input: '',
      key: makeKey({ return: true, ctrl: true }),
      state: { runActive: false },
      expected: 'input',
    },
    {
      name: 'ctrl+⏎ is input when the screen takes no send now',
      input: '',
      key: makeKey({ return: true, ctrl: true }),
      state: { hasSendNow: false },
      expected: 'input',
    },
    {
      name: 'ctrl+⏎ is input in an answer',
      input: '',
      key: makeKey({ return: true, ctrl: true }),
      state: { mode: 'question' as const },
      expected: 'input',
    },
    {
      name: 'ctrl+⏎ sends now before the commands-only refusal',
      input: '',
      key: makeKey({ return: true, ctrl: true }),
      state: { commandsOnly: true },
      expected: 'send-now',
    },
    {
      name: 'Tab goes to the screen',
      input: '',
      key: makeKey({ tab: true }),
      state: {},
      expected: 'tab',
    },
    {
      name: 'shift+Tab goes to the screen',
      input: '',
      key: makeKey({ tab: true, shift: true }),
      state: {},
      expected: 'tab',
    },
    {
      name: 'an open list keeps Tab',
      input: '',
      key: makeKey({ tab: true }),
      state: { completionOpen: true },
      expected: 'input',
    },
    {
      name: 'Tab is input when the screen takes no Tab',
      input: '',
      key: makeKey({ tab: true }),
      state: { hasTab: false },
      expected: 'input',
    },
    {
      name: 'ctrl+v pastes an image',
      input: 'v',
      key: makeKey({ ctrl: true }),
      state: {},
      expected: 'paste-image',
    },
    {
      name: 'ctrl+v pastes an image before the commands-only refusal',
      input: 'v',
      key: makeKey({ ctrl: true }),
      state: { commandsOnly: true },
      expected: 'paste-image',
    },
    {
      name: 'a letter is refused on an empty commands-only draft',
      input: 'a',
      key: makeKey(),
      state: { commandsOnly: true },
      expected: 'commands-only',
    },
    {
      name: 'a slash opens a command on an empty commands-only draft',
      input: '/',
      key: makeKey(),
      state: { commandsOnly: true },
      expected: 'input',
    },
    {
      name: 'a letter after the first character of a commands-only draft is input',
      input: 'a',
      key: makeKey(),
      state: { commandsOnly: true, draftEmpty: false },
      expected: 'input',
    },
    {
      name: 'an arrow is input on an empty commands-only draft',
      input: '',
      key: makeKey({ upArrow: true }),
      state: { commandsOnly: true },
      expected: 'input',
    },
    { name: 'a letter is input', input: 'a', key: makeKey(), state: {}, expected: 'input' },
  ])('$name', ({ input, key, state, expected }) => {
    expect(gateComposerKey(input, key, { ...STATE, ...state })).toBe(expected);
  });
});
