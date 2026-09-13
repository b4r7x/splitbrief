import { describe, expect, it } from 'vitest';
import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';
import { getLogo, HOME_LOGO_ROWS } from './logo.js';

describe('getLogo', () => {
  it('is the wordmark on one row, with no art to measure around', () => {
    const logo = getLogo();

    expect(logo).toBe(SPLITBRIEF_IDENTITY.displayName);
    expect(logo.split('\n')).toHaveLength(HOME_LOGO_ROWS);
  });
});
