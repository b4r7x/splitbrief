import { describe, expect, it } from 'vitest';
import { classifyHaltSignature, HALT_SIGNATURES, HALT_TAIL_LINES } from './halts.js';

describe('classifyHaltSignature', () => {
  it("'Not logged in' on the last line classifies auth", () => {
    expect(classifyHaltSignature(['building…', 'Not logged in'])).toBe('auth');
  });

  it('a bare 401 in an NDJSON line is not a halt', () => {
    expect(classifyHaltSignature(['{"type":"progress","code":401,"tokens":429}'])).toBeNull();
  });

  it('classifies usage, missing-model and spawn phrases', () => {
    expect(classifyHaltSignature(['Error: quota exceeded'])).toBe('usage');
    expect(classifyHaltSignature(['unknown model: gpt-9'])).toBe('missing-model');
    expect(classifyHaltSignature(['error: unknown flag --yolo'])).toBe('spawn');
  });

  it('a run whose own output names billing or a rate limit is not a usage halt', () => {
    expect(classifyHaltSignature(['writing src/billing/webhook.ts', 'tsc: 1 error'])).toBeNull();
    expect(classifyHaltSignature(['added a rate limit to the handler'])).toBeNull();
    expect(classifyHaltSignature(['APIError: Rate limit exceeded'])).toBe('usage');
    expect(classifyHaltSignature(['Rate limit reached for model `llama-3.3`'])).toBe('usage');
  });

  it("a shelled-out EACCES or a remote's refusal is not a halt, the tool's own wording is", () => {
    expect(classifyHaltSignature(['mkdir /var/cache: permission denied'])).toBeNull();
    expect(classifyHaltSignature(['remote: user is unauthorized to push'])).toBeNull();
    expect(classifyHaltSignature(['Write requires permissions. Use --yolo'])).toBe('spawn');
    expect(classifyHaltSignature(['unexpected status 401 Unauthorized: Missing bearer'])).toBe(
      'auth',
    );
  });

  it('only looks at the last HALT_TAIL_LINES lines', () => {
    const lines = ['not logged in', ...Array.from({ length: HALT_TAIL_LINES }, () => 'ok')];
    expect(classifyHaltSignature(lines)).toBeNull();
  });

  it('every signature is lowercase', () => {
    for (const phrases of Object.values(HALT_SIGNATURES)) {
      for (const phrase of phrases) expect(phrase).toBe(phrase.toLowerCase());
    }
  });
});
