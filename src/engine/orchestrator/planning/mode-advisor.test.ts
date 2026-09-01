import { describe, it, expect } from 'vitest';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { adviseMode, formatAdvisoryText, type AdvisorResult } from './mode-advisor.js';

describe('adviseMode — risk classification', () => {
  it('typo in standard suggests quick (downgrade)', () => {
    const result = adviseMode('fix typo in footer', 'standard');
    expect(result.kind).toBe('downgrade');
    expect(result.suggestedMode).toBe('quick');
    expect(result.risk).toBe('trivial');
  });

  it('marks a trivial prompt so the quick planner gets its narrow-brief hint', () => {
    const result = adviseMode('fix typo in README', 'quick');
    expect(result.risk).toBe('trivial');
    expect(result.kind).toBe('none');
  });

  it('auth/security prompt in quick suggests speckit (upgrade)', () => {
    const result = adviseMode('add auth middleware to protect admin routes', 'quick');
    expect(result.kind).toBe('upgrade');
    expect(result.suggestedMode).toBe('speckit');
    expect(result.risk).toBe('high');
  });

  it('vague prompt emits missing-context', () => {
    const result = adviseMode('improve it', 'standard');
    expect(result.kind).toBe('missing-context');
    expect(result.missing).toContain('vague target');
  });

  it('non-trivial prompt without area/file/module emits missing-context', () => {
    const result = adviseMode(
      'add a better retry behavior with clearer failure handling and assertions',
      'standard',
    );
    expect(result.kind).toBe('missing-context');
    expect(result.missing).toContain('no area/file/module');
  });

  it('flags no validation hint and no done criteria', () => {
    const result = adviseMode(
      'improve workflow state handling around queued messages for edge cases',
      'standard',
    );
    expect(result.kind).toBe('missing-context');
    expect(result.missing).toContain('no validation hint');
    expect(result.missing).toContain('no done criteria');
  });

  it('small file-scoped bug suggests quick', () => {
    const result = adviseMode('fix null check in src/utils/parser.ts', 'standard');
    expect(result.kind).toBe('downgrade');
    expect(result.suggestedMode).toBe('quick');
  });

  it('matching selected mode emits none', () => {
    const result = adviseMode('add oauth login flow with JWT refresh tokens', 'speckit');
    expect(result.kind).toBe('none');
  });

  it('low confidence does NOT upgrade or downgrade', () => {
    // normal risk → confidence 0.60 < 0.65, from 'quick' that would be an upgrade but confidence gate blocks it
    const result = adviseMode('refactor user settings page', 'quick');
    expect(result.confidence).toBeLessThan(0.65);
    expect(result.kind).not.toBe('upgrade');
    expect(result.kind).not.toBe('downgrade');
  });
});

describe('adviseMode — trivial patterns', () => {
  it.each<[string, WorkflowMode, boolean, WorkflowMode]>([
    ['fix typo in foo', 'standard', true, 'quick'],
    ['rename foo to bar', 'standard', true, 'quick'],
    // Long oauth prompt correctly classifies as high risk → upgrade to speckit
    [
      'refactor the entire authentication subsystem to support OAuth 2.0 with PKCE, bearer tokens, and refresh rotation; also fix the typo in the login page header while we are at it',
      'standard',
      true,
      'speckit',
    ],
    ['fix typo', 'quick', false, 'quick'],
  ])(
    'prompt=%s mode=%s → expectAdvice=%s suggested=%s',
    (prompt, mode, expectAdvice, suggested) => {
      const result = adviseMode(prompt, mode);
      expect(result.kind !== 'none').toBe(expectAdvice);
      expect(result.suggestedMode).toBe(suggested);
    },
  );

  it('handles empty prompt without advising', () => {
    const result = adviseMode('', 'standard');
    expect(result.kind).toBe('none');
  });

  it('handles whitespace-only prompt without advising', () => {
    const result = adviseMode('   \n  ', 'standard');
    expect(result.kind).toBe('none');
  });

  it('matches keywords case-insensitively', () => {
    const result = adviseMode('Fix TYPO here', 'standard');
    expect(result.kind).not.toBe('none');
    expect(result.suggestedMode).toBe('quick');
  });
});

describe('adviseMode — high risk patterns', () => {
  it.each<[string, WorkflowMode]>([
    ['fix security vulnerability in the API', 'standard'],
    ['run database migration for new schema', 'quick'],
    ['update config schema to add new fields', 'standard'],
    ['add authentication endpoint', 'quick'],
    ['implement login system', 'quick'],
    ['add password hashing', 'standard'],
    ['set up CSRF protection', 'standard'],
  ])('high-risk prompt "%s" in %s → upgrade to speckit', (prompt, mode) => {
    const result = adviseMode(prompt, mode);
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
    expect(result.factors.some((f) => f.startsWith('matched:'))).toBe(true);
  });

  it('confidence is >= 0.65 when upgrade or downgrade fires', () => {
    const result = adviseMode('fix typo', 'standard');
    expect(result.kind).toBe('downgrade');
    expect(result.confidence).toBeGreaterThanOrEqual(0.65);
  });
});

describe('formatAdvisoryText', () => {
  it('returns empty string for kind=none', () => {
    const result: AdvisorResult = {
      kind: 'none',
      risk: 'normal',
      currentMode: 'standard',
      suggestedMode: 'standard',
      confidence: 0,
      factors: [],
      missing: [],
    };
    expect(formatAdvisoryText(result)).toBe('');
  });

  it('formats downgrade advisory concisely with "likely" phrasing', () => {
    const result = adviseMode('fix typo in footer', 'standard');
    const text = formatAdvisoryText(result);
    expect(text).toContain('advisor:');
    expect(text).toContain('likely');
    expect(text).toContain('quick');
    expect(text).not.toContain('\n');
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
