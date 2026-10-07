import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDiagnosticSink, warnError, warnStderr } from './warn.js';

const HOSTILE = 'AUDIT_SYNTHETIC_DIAGNOSTIC \x1b[2Jcleared\x1b]0;title\x07';
const SANITIZED = 'AUDIT_SYNTHETIC_DIAGNOSTIC cleared';

function captureStderr(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('warn diagnostics ownership', () => {
  it('writes sanitized stderr when no sink owns diagnostics', () => {
    const stderr = captureStderr();

    warnError(HOSTILE, new Error('\x1b[31mboom'));
    warnStderr(HOSTILE);
    warnStderr(HOSTILE, 'log-only');

    expect(stderr).toEqual([`${SANITIZED}: boom\n`, `${SANITIZED}\n`, `${SANITIZED}\n`]);
  });

  it('hands each diagnostic to the installed sink once and keeps stderr silent', () => {
    const stderr = captureStderr();
    const received: string[] = [];
    const release = installDiagnosticSink((message) => received.push(message));

    warnError(HOSTILE, new Error('boom'));
    warnStderr(HOSTILE);
    release();

    expect(received).toEqual([`${SANITIZED}: boom`, SANITIZED]);
    expect(stderr).toEqual([]);

    warnStderr('after teardown');
    expect(stderr).toEqual(['after teardown\n']);
    expect(received).toHaveLength(2);
  });

  it('returns ownership to the prior sink on idempotent release in any order', () => {
    const stderr = captureStderr();
    const outer: string[] = [];
    const inner: string[] = [];
    const releaseOuter = installDiagnosticSink((message) => outer.push(message));
    const releaseInner = installDiagnosticSink((message) => inner.push(message));

    warnStderr('to inner');
    releaseInner();
    releaseInner();
    warnStderr('to outer');

    const releaseLate = installDiagnosticSink((message) => inner.push(message));
    releaseOuter();
    releaseOuter();
    warnStderr('to late');
    releaseLate();
    warnStderr('to stderr');

    expect(inner).toEqual(['to inner', 'to late']);
    expect(outer).toEqual(['to outer']);
    expect(stderr).toEqual(['to stderr\n']);
  });
});
