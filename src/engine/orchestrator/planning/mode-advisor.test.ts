import { describe, it, expect, beforeEach } from 'vitest';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import {
  adviseMode,
  formatAdvisoryText,
  getAdvisory,
  setAdvisory,
  subscribeAdvisory,
  __resetAdvisoryForTests,
} from './mode-advisor.js';

describe('adviseMode — risk classification', () => {
  it('typo in standard suggests instant (downgrade)', () => {
    const result = adviseMode('fix typo in footer', 'standard');
    expect(result.kind).toBe('downgrade');
    expect(result.suggestedMode).toBe('instant');
    expect(result.risk).toBe('trivial');
    expect(result.shouldAdvise).toBe(true);
  });

  it('auth/security prompt in quick suggests speckit (upgrade)', () => {
    const result = adviseMode('add auth middleware to protect admin routes', 'quick');
    expect(result.kind).toBe('upgrade');
    expect(result.suggestedMode).toBe('speckit');
    expect(result.risk).toBe('high');
    expect(result.shouldAdvise).toBe(true);
  });

  it('vague prompt emits missing-context', () => {
    const result = adviseMode('improve it', 'standard');
    expect(result.kind).toBe('missing-context');
    expect(result.missing).toContain('vague target');
    expect(result.shouldAdvise).toBe(true);
  });

  it('non-trivial prompt without area/file/module emits missing-context', () => {
    const result = adviseMode('add a better retry behavior with clearer failure handling and assertions', 'standard');
    expect(result.kind).toBe('missing-context');
    expect(result.missing).toContain('no area/file/module');
  });

  it('flags no validation hint and no done criteria', () => {
    const result = adviseMode('improve workflow state handling around queued messages for edge cases', 'standard');
    expect(result.kind).toBe('missing-context');
    expect(result.missing).toContain('no validation hint');
    expect(result.missing).toContain('no done criteria');
  });

  it('small file-scoped bug suggests quick', () => {
    const result = adviseMode('fix null check in src/utils/parser.ts', 'standard');
    expect(result.kind).toBe('downgrade');
    expect(result.suggestedMode).toBe('quick');
    expect(result.shouldAdvise).toBe(true);
  });

  it('matching selected mode emits none', () => {
    const result = adviseMode('add oauth login flow with JWT refresh tokens', 'speckit');
    expect(result.kind).toBe('none');
    expect(result.shouldAdvise).toBe(false);
  });

  it('low confidence does NOT upgrade or downgrade', () => {
    // normal risk → confidence 0.60 < 0.65, from 'instant' that would be an upgrade but confidence gate blocks it
    const result = adviseMode('refactor user settings page', 'instant');
    expect(result.confidence).toBeLessThan(0.65);
    expect(result.kind).not.toBe('upgrade');
    expect(result.kind).not.toBe('downgrade');
  });
});

describe('adviseMode — trivial patterns', () => {
  it.each<[string, WorkflowMode, boolean, WorkflowMode]>([
    ['fix typo in foo', 'standard', true, 'instant'],
    ['rename foo to bar', 'standard', true, 'instant'],
    // Long oauth prompt correctly classifies as high risk → upgrade to speckit
    [
      'refactor the entire authentication subsystem to support OAuth 2.0 with PKCE, bearer tokens, and refresh rotation; also fix the typo in the login page header while we are at it',
      'standard',
      true,
      'speckit',
    ],
    ['fix typo', 'instant', false, 'instant'],
  ])('prompt=%s mode=%s → shouldAdvise=%s suggested=%s', (prompt, mode, shouldAdvise, suggested) => {
    const result = adviseMode(prompt, mode);
    expect(result.shouldAdvise).toBe(shouldAdvise);
    expect(result.suggestedMode).toBe(suggested);
  });

  it('handles empty prompt without advising', () => {
    const result = adviseMode('', 'standard');
    expect(result.kind).toBe('none');
    expect(result.shouldAdvise).toBe(false);
  });

  it('handles whitespace-only prompt without advising', () => {
    const result = adviseMode('   \n  ', 'standard');
    expect(result.kind).toBe('none');
    expect(result.shouldAdvise).toBe(false);
  });

  it('matches keywords case-insensitively', () => {
    const result = adviseMode('Fix TYPO here', 'standard');
    expect(result.shouldAdvise).toBe(true);
    expect(result.suggestedMode).toBe('instant');
  });
});

describe('adviseMode — high risk patterns', () => {
  it('security in standard mode → upgrade to speckit', () => {
    const result = adviseMode('fix security vulnerability in the API', 'standard');
    expect(result.kind).toBe('upgrade');
    expect(result.suggestedMode).toBe('speckit');
    expect(result.risk).toBe('high');
  });

  it('database migration in quick mode → upgrade to speckit', () => {
    const result = adviseMode('run database migration for new schema', 'quick');
    expect(result.kind).toBe('upgrade');
    expect(result.suggestedMode).toBe('speckit');
  });

  it('config schema change in standard → upgrade', () => {
    const result = adviseMode('update config schema to add new fields', 'standard');
    expect(result.kind).toBe('upgrade');
    expect(result.risk).toBe('high');
  });

  it('authentication endpoint in quick → upgrade to speckit', () => {
    const result = adviseMode('add authentication endpoint', 'quick');
    expect(result.kind).toBe('upgrade');
    expect(result.suggestedMode).toBe('speckit');
    expect(result.risk).toBe('high');
  });

  it('login system in quick → upgrade to speckit', () => {
    const result = adviseMode('implement login system', 'quick');
    expect(result.kind).toBe('upgrade');
    expect(result.suggestedMode).toBe('speckit');
    expect(result.risk).toBe('high');
  });

  it('password hashing in standard → upgrade to speckit', () => {
    const result = adviseMode('add password hashing', 'standard');
    expect(result.kind).toBe('upgrade');
    expect(result.suggestedMode).toBe('speckit');
    expect(result.risk).toBe('high');
  });

  it('CSRF protection in standard → upgrade to speckit', () => {
    const result = adviseMode('set up CSRF protection', 'standard');
    expect(result.kind).toBe('upgrade');
    expect(result.suggestedMode).toBe('speckit');
    expect(result.risk).toBe('high');
  });

  it('rename authClient variable is NOT high-risk (no over-broadening)', () => {
    const result = adviseMode('rename authClient variable', 'standard');
    expect(result.risk).not.toBe('high');
  });
});

describe('adviseMode — confidence and factors', () => {
  it('includes factors array with matched signals', () => {
    const result = adviseMode('fix typo in comment', 'standard');
    expect(result.factors.length).toBeGreaterThan(0);
    expect(result.factors.some(f => f.startsWith('matched:'))).toBe(true);
  });

  it('confidence is >= 0.65 when upgrade or downgrade fires', () => {
    const result = adviseMode('fix typo', 'standard');
    if (result.kind === 'upgrade' || result.kind === 'downgrade') {
      expect(result.confidence).toBeGreaterThanOrEqual(0.65);
    }
  });
});

describe('formatAdvisoryText', () => {
  it('returns empty string for kind=none', () => {
    const result = adviseMode('refactor user page', 'standard');
    if (result.kind === 'none') {
      expect(formatAdvisoryText(result)).toBe('');
    }
  });

  it('formats downgrade advisory concisely with "likely" phrasing', () => {
    const result = adviseMode('fix typo in footer', 'standard');
    const text = formatAdvisoryText(result);
    expect(text).toContain('advisor:');
    expect(text).toContain('likely');
    expect(text).toContain('instant');
    expect(text).not.toContain('\n');
    // Should be short — no paragraphs
    expect(text.length).toBeLessThan(80);
  });

  it('formats upgrade advisory concisely with "consider" phrasing', () => {
    const result = adviseMode('add auth middleware', 'quick');
    const text = formatAdvisoryText(result);
    expect(text).toContain('advisor:');
    expect(text).toContain('consider');
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThan(80);
  });

  it('formats missing-context advisory with missing flag', () => {
    const result = adviseMode('improve it', 'standard');
    const text = formatAdvisoryText(result);
    expect(text).toContain('advisor:');
    expect(text.length).toBeLessThan(80);
  });
});

describe('advisory store', () => {
  beforeEach(() => {
    __resetAdvisoryForTests();
  });

  it('starts with no advisory', () => {
    expect(getAdvisory()).toBeNull();
  });

  it('notifies subscribers when advisory changes', () => {
    let calls = 0;
    const unsubscribe = subscribeAdvisory(() => {
      calls += 1;
    });

    const advisory = adviseMode('fix typo', 'standard');
    setAdvisory(advisory);
    expect(getAdvisory()).toEqual(advisory);
    expect(calls).toBe(1);

    setAdvisory(null);
    expect(getAdvisory()).toBeNull();
    expect(calls).toBe(2);

    unsubscribe();
    setAdvisory(advisory);
    expect(calls).toBe(2);
  });

  it('skips notification when value is unchanged reference', () => {
    let calls = 0;
    subscribeAdvisory(() => {
      calls += 1;
    });
    setAdvisory(null);
    expect(calls).toBe(0);
  });
});
