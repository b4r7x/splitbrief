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

describe('adviseMode', () => {
  it.each<[string, WorkflowMode, boolean, WorkflowMode]>([
    ['fix typo in foo', 'standard', true, 'instant'],
    ['rename foo to bar', 'standard', true, 'instant'],
    ['add null check to service', 'speckit', true, 'instant'],
    [
      'refactor the entire authentication subsystem to support OAuth 2.0 with PKCE, bearer tokens, and refresh rotation; also fix the typo in the login page header while we are at it',
      'standard',
      false,
      'standard',
    ],
    ['build auth system', 'standard', false, 'standard'],
    ['fix typo', 'quick', false, 'quick'],
    ['fix typo', 'instant', false, 'instant'],
  ])('prompt=%s mode=%s → shouldAdvise=%s suggested=%s', (prompt, mode, shouldAdvise, suggested) => {
    const result = adviseMode(prompt, mode);
    expect(result.shouldAdvise).toBe(shouldAdvise);
    expect(result.suggestedMode).toBe(suggested);
  });

  it('handles empty prompt without advising', () => {
    const result = adviseMode('', 'standard');
    expect(result.shouldAdvise).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('handles whitespace-only prompt without advising', () => {
    const result = adviseMode('   \n  ', 'standard');
    expect(result.shouldAdvise).toBe(false);
  });

  it('matches keywords case-insensitively', () => {
    const result = adviseMode('Fix TYPO here', 'standard');
    expect(result.shouldAdvise).toBe(true);
    expect(result.suggestedMode).toBe('instant');
  });

  it('sets reason when advising', () => {
    const result = adviseMode('fix typo', 'standard');
    expect(result.reason).toBe('short-prompt-with-trivial-keyword');
  });
});

describe('formatAdvisoryText', () => {
  it('formats advisory text with current and suggested mode', () => {
    const text = formatAdvisoryText({
      shouldAdvise: true,
      currentMode: 'standard',
      suggestedMode: 'instant',
      reason: 'short-prompt-with-trivial-keyword',
    });
    expect(text).toBe('This looks trivial. Consider --mode instant instead of --mode standard.');
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
