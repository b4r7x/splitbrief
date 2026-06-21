import { describe, expect, it } from 'vitest';
import { sanitizeWorkflowDisplayText } from './safe-text.js';

describe('sanitizeWorkflowDisplayText', () => {
  it('redacts secrets and JWTs and strips terminal controls', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const text = `token=${jwt} key=sk-abcdefghijklmnopqrstuvwxyz \u001b[31mred\u001b[0m`;

    expect(sanitizeWorkflowDisplayText(text)).toBe(
      'token=***REDACTED*** key=sk-***REDACTED*** red',
    );
  });

  it('redacts secrets that were split by terminal control sequences', () => {
    expect(sanitizeWorkflowDisplayText('key=sk-\u001b[31mabcdefghijklmnopqrstuvwxyz')).toBe(
      'key=sk-***REDACTED***',
    );
  });
});
