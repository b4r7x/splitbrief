import { describe, it, expect } from 'vitest';
import { consoleWorkflowFeature, TRANSCRIPT_OMITTED_MESSAGE } from './transcript-policy.js';

describe('consoleWorkflowFeature', () => {
  it('strips terminal controls and omits feature text when persistTranscript is false', () => {
    expect(
      consoleWorkflowFeature({
        feature: 'add \u001b]0;pwned\u0007login',
        persistTranscript: false,
      }),
    ).toBe(TRANSCRIPT_OMITTED_MESSAGE);
  });

  it('returns the sanitized feature when persistTranscript is true', () => {
    expect(
      consoleWorkflowFeature({
        feature: 'add \u001b]0;pwned\u0007login',
        persistTranscript: true,
      }),
    ).toBe('add login');
  });
});
