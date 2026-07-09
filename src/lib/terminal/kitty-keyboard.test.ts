import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectKittyKeyboardFlags, resolveKittyFlagBits } from './kitty-keyboard.js';

describe('detectKittyKeyboardFlags', () => {
  let savedTerm: string | undefined;
  let savedTermProgram: string | undefined;

  beforeEach(() => {
    savedTerm = process.env['TERM'];
    savedTermProgram = process.env['TERM_PROGRAM'];
  });

  afterEach(() => {
    if (savedTerm === undefined) delete process.env['TERM'];
    else process.env['TERM'] = savedTerm;
    if (savedTermProgram === undefined) delete process.env['TERM_PROGRAM'];
    else process.env['TERM_PROGRAM'] = savedTermProgram;
  });

  it('never reads $TERM: identical result for TERM=xterm-kitty and TERM unset', () => {
    delete process.env['TERM_PROGRAM'];

    process.env['TERM'] = 'xterm-kitty';
    const withKittyTerm = detectKittyKeyboardFlags();

    delete process.env['TERM'];
    const withoutTerm = detectKittyKeyboardFlags();

    expect(withKittyTerm).toEqual(withoutTerm);
    expect(withKittyTerm.mode).toBe('auto');
  });

  it("returns 'enabled' for the TERM_PROGRAM allow-list (iTerm.app)", () => {
    delete process.env['TERM'];
    process.env['TERM_PROGRAM'] = 'iTerm.app';

    const flags = detectKittyKeyboardFlags();

    expect(flags.mode).toBe('enabled');
    expect(flags.flags).toEqual(['disambiguateEscapeCodes']);
  });

  it("returns 'enabled' for the TERM_PROGRAM allow-list (zed)", () => {
    process.env['TERM_PROGRAM'] = 'zed';

    expect(detectKittyKeyboardFlags().mode).toBe('enabled');
  });

  it("returns 'auto' for an unknown TERM_PROGRAM", () => {
    process.env['TERM_PROGRAM'] = 'Apple_Terminal';

    const flags = detectKittyKeyboardFlags();

    expect(flags.mode).toBe('auto');
    expect(flags.flags).toEqual(['disambiguateEscapeCodes']);
  });

  it("returns 'auto' when TERM_PROGRAM is unset", () => {
    delete process.env['TERM_PROGRAM'];

    expect(detectKittyKeyboardFlags().mode).toBe('auto');
  });
});

describe('resolveKittyFlagBits', () => {
  it('maps disambiguateEscapeCodes to bit 1', () => {
    expect(resolveKittyFlagBits(detectKittyKeyboardFlags().flags)).toBe(1);
  });
});
