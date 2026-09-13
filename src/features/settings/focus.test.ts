import { describe, expect, it } from 'vitest';
import { parseSettingsFocus } from './focus.js';

describe('parseSettingsFocus', () => {
  it('names no target without a focus', () => {
    expect(parseSettingsFocus(undefined)).toEqual({
      initialKey: undefined,
      initialFilter: undefined,
    });
  });

  it('reads a bare focus as the row key', () => {
    expect(parseSettingsFocus('seat:build')).toEqual({
      initialKey: 'seat:build',
      initialFilter: undefined,
    });
  });

  it('reproduces a typed filter', () => {
    expect(parseSettingsFocus('filter:temp')).toEqual({
      initialKey: undefined,
      initialFilter: 'temp',
    });
  });

  it('keeps the colons of a seat key', () => {
    expect(parseSettingsFocus('seat:review')).toEqual({
      initialKey: 'seat:review',
      initialFilter: undefined,
    });
  });

  it('names no target on an empty focus', () => {
    expect(parseSettingsFocus('')).toEqual({
      initialKey: undefined,
      initialFilter: undefined,
    });
  });
});
