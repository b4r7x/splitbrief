import { describe, it, expect, beforeEach } from 'vitest';
import {
  adviseMode,
  formatAdvisoryText,
  setAdvisory,
  getAdvisory,
  __resetAdvisoryForTests,
} from '../../../engine/orchestrator/planning/mode-advisor.js';

// Tests exercise the advisory text as it would be displayed by InputFooter.
// The footer renders formatAdvisoryText(advisory) when advisory.kind !== 'none'.

describe('InputFooter advisory display', () => {
  beforeEach(() => {
    __resetAdvisoryForTests();
  });

  it('shows downgrade advisory for trivial prompt in standard mode', () => {
    const advisory = adviseMode('fix typo in footer', 'standard');
    setAdvisory(advisory.kind !== 'none' ? advisory : null);
    const stored = getAdvisory();
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('downgrade');
    const text = formatAdvisoryText(stored!);
    expect(text).toMatch(/^advisor:/);
    expect(text).toContain('instant');
  });

  it('shows upgrade advisory for high-risk prompt in quick mode', () => {
    const advisory = adviseMode('add oauth authentication middleware', 'quick');
    setAdvisory(advisory.kind !== 'none' ? advisory : null);
    const stored = getAdvisory();
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('upgrade');
    const text = formatAdvisoryText(stored!);
    expect(text).toMatch(/^advisor:/);
    expect(text).toContain('speckit');
  });

  it('shows missing-context advisory for vague prompt', () => {
    const advisory = adviseMode('improve it', 'standard');
    setAdvisory(advisory.kind !== 'none' ? advisory : null);
    const stored = getAdvisory();
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe('missing-context');
    const text = formatAdvisoryText(stored!);
    expect(text).toMatch(/^advisor:/);
  });

  it('stores null (no advisory shown) when mode matches risk', () => {
    // speckit for high-risk → kind none
    const advisory = adviseMode('add auth with JWT refresh tokens', 'speckit');
    setAdvisory(advisory.kind !== 'none' ? advisory : null);
    expect(getAdvisory()).toBeNull();
  });

  it('advisory text is short enough for footer (under 80 chars)', () => {
    const cases = [
      adviseMode('fix typo in login page', 'standard'),
      adviseMode('add oauth auth', 'quick'),
      adviseMode('improve it', 'standard'),
    ];
    for (const advisory of cases) {
      if (advisory.kind !== 'none') {
        const text = formatAdvisoryText(advisory);
        expect(text.length).toBeLessThan(80);
      }
    }
  });

  it('advisory text has no newlines (single line for footer)', () => {
    const advisory = adviseMode('fix typo here', 'standard');
    if (advisory.kind !== 'none') {
      const text = formatAdvisoryText(advisory);
      expect(text).not.toContain('\n');
    }
  });
});
