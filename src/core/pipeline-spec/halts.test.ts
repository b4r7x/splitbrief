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
    // Captured live from `agy -p` (antigravity 1.2.7) on 2026-09-21.
    expect(
      classifyHaltSignature([
        'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h6m30s.',
      ]),
    ).toBe('usage');
    expect(classifyHaltSignature(['{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'])).toBe(
      'usage',
    );
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

  it('a Claude Code sandbox that cannot start halts only when failIfUnavailable refuses the launch', () => {
    // The message templates in the claude 2.1.281 binary; the dependency names are illustrative.
    const reason =
      'sandbox is enabled but dependencies are missing: bubblewrap, socat · install missing tools (e.g. apt install bubblewrap socat) or see https://code.claude.com/docs/en/sandboxing';
    expect(
      classifyHaltSignature([
        `Error: sandbox required but unavailable: ${reason}`,
        '  sandbox.failIfUnavailable is set — refusing to start without a working sandbox.',
      ]),
    ).toBe('spawn');
    expect(
      classifyHaltSignature([
        'Error: sandbox required but unavailable: sandbox is enabled but WSL1 is not supported (requires WSL2)',
      ]),
    ).toBe('spawn');
    expect(
      classifyHaltSignature([
        `⚠ Sandbox disabled: ${reason}`,
        '  Commands will run WITHOUT sandboxing. Network and filesystem restrictions will NOT be enforced.',
      ]),
    ).toBeNull();
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
