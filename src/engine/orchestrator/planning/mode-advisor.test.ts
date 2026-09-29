import { describe, it, expect } from 'vitest';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { adviseMode, adviseRun, formatAdvisoryText, type AdvisorResult } from './mode-advisor.js';

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

  it.each<[string, string]>([
    [
      'a scenario id in a code span',
      '- Render and look at: `overlay-picker-seat-swap`, `overlay-picker-auth-config-owned`',
    ],
    ['a file name in a code span', 'count the lines `session.jsonl` holds for each run'],
    ['a kebab-case name in prose', 'render the overlay-picker-auth-config-owned scenario again'],
    ['a snake_case name in prose', 'raise the auth_token_ttl default to one hour'],
    [
      'fenced code',
      'keep the reader as it is:\n```ts\nconst password = readSecret(session);\n```\ntrim the rest',
    ],
    ['a fence that never closes', 'trim the fixture\n~~~\nlogin(password)'],
    ["a brief's file line", 'file: src/features/workflow/hooks/use-run-loop.ts'],
    [
      "a brief's files list",
      'files: [src/features/workflow/hooks/use-run-loop.ts, src/stores/workflow/session.ts]',
    ],
    ['an attached file header', '--- @docs/auth/login.md ---\nthe copy reads badly'],
  ])('%s is a name, not a risk signal', (_case, prompt) => {
    expect(adviseMode(prompt, 'quick').risk).not.toBe('high');
  });

  it.each<[string]>([
    ['render `overlay-picker-auth-config-owned`, then fix the login redirect'],
    ['harden the session cookie flags'],
    ['rotate the auth secret before the release'],
    ['add a git hook that blocks the push'],
    ['harden the login page'],
    ['```\nconst x = 1;\n```\nthen hash the password'],
  ])('prose "%s" is still high-risk', (prompt) => {
    expect(adviseMode(prompt, 'quick').risk).toBe('high');
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
    // A prompt upgrade keeps its risk reason; the classifier's matched patterns stay internal.
    expect(text).toContain('security/config risk');
    expect(text).not.toContain('matched:');
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThan(80);
  });

  it('formats missing-context advisory with missing flag', () => {
    const result = adviseMode('improve it', 'standard');
    const text = formatAdvisoryText(result);
    expect(text).toContain('advisor:');
    expect(text.length).toBeLessThan(80);
  });

  it('still formats a stop advisory a run logged before count-only advice was removed', () => {
    const result: AdvisorResult = {
      kind: 'stop',
      risk: 'normal',
      currentMode: 'standard',
      suggestedMode: 'standard',
      confidence: 1,
      factors: ['13 briefs over the 12 cap'],
      missing: [],
    };
    expect(formatAdvisoryText(result)).toBe('advisor: 13 briefs over the 12 cap · split the work');
  });
});

describe('adviseRun — the verdict a run shows from its saved inputs', () => {
  const NAMES_ONLY = '- render `overlay-picker-auth-config-owned`\n- `npm test` passes';

  it('reads the sentence and its @ context the way the prompt advice does', () => {
    const run = { feature: 'trim the catalog fixture', plannerContext: NAMES_ONLY };
    expect(adviseRun({ ...run, mode: 'quick' })).toEqual(
      adviseMode(`${run.feature}\n\n${run.plannerContext}`, 'quick'),
    );
  });

  it('earns no advice for a planned run whose context only names a scenario', () => {
    const advice = adviseRun({
      feature: 'Trim the 140 KB opencode catalog fixture below 50 KB',
      plannerContext: NAMES_ONLY,
      mode: 'quick',
    });
    expect(advice.kind).toBe('none');
    expect(formatAdvisoryText(advice)).toBe('');
  });

  it('derives no count-only advice for a saved run with more than twelve briefs', () => {
    const advice = adviseRun({
      feature: 'Update the typecheck gate in src/engine/validation so the tests pass',
      mode: 'quick',
    });
    expect(advice.kind).not.toBe('stop');
    expect(advice.factors.join(' ')).not.toMatch(/briefs? over|files over/);
  });

  it('keeps contextual risk advice', () => {
    const advice = adviseRun({
      feature: 'harden the login page so the tests pass',
      mode: 'standard',
    });
    expect(advice).toMatchObject({ kind: 'upgrade', risk: 'high', suggestedMode: 'speckit' });
  });
});

describe('adviseMode — trivial and small signals are whole words of prose', () => {
  it.each<[string, string]>([
    ['a longer word that starts with one', 'fix the typography of the settings page'],
    ['a kebab-case name', 'add the rename-session command'],
    ['a name in a code span', 'add a `rename` subcommand to the cli'],
  ])('%s is not a trivial edit', (_case, prompt) => {
    expect(adviseMode(prompt, 'standard').risk).not.toBe('trivial');
  });

  it('a camelCase name is not a small change', () => {
    expect(adviseMode('wire the loggerLevel option into the config', 'standard').risk).not.toBe(
      'small',
    );
  });

  it.each<[string]>([
    ['fix typos in README'],
    ['rename foo to bar'],
    ['fix indentation in the footer'],
    ['reformatting only, no logic change'],
  ])('"%s" is still a trivial edit', (prompt) => {
    expect(adviseMode(prompt, 'standard').risk).toBe('trivial');
  });

  it.each<[string]>([
    ['add logging to the parser before the retry'],
    ['remove the stray console.log call'],
    ['add a null check before the call'],
  ])('"%s" is still a small change', (prompt) => {
    expect(adviseMode(prompt, 'standard').risk).toBe('small');
  });
});
