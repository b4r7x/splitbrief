import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableDebugLog, loggedDiagnostics } from '#testing/helpers/debug-log.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { resetLoggerForTests } from './logger.js';
import * as warn from './warn.js';
import { installDiagnosticSink, warnError, warnStderr } from './warn.js';

const HOSTILE = 'AUDIT_SYNTHETIC_DIAGNOSTIC \x1b[2Jcleared\x1b]0;title\x07';
const SANITIZED = 'AUDIT_SYNTHETIC_DIAGNOSTIC cleared';

let projectDir: string;

function captureStderr(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

beforeEach(() => {
  projectDir = createTempDir('warn-test');
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLoggerForTests();
  cleanupTempDir(projectDir);
});

describe('warn diagnostics ownership', () => {
  it('writes sanitized stderr when no sink owns diagnostics', () => {
    const stderr = captureStderr();

    warnError(HOSTILE, new Error('\x1b[31mboom'), 'feedback');
    warnStderr(HOSTILE, 'feedback');
    warnStderr(HOSTILE, 'at-exit');

    expect(stderr).toEqual([`${SANITIZED}: boom\n`, `${SANITIZED}\n`, `${SANITIZED}\n`]);
  });

  it('hands each diagnostic to the installed sink once and keeps stderr silent', () => {
    const stderr = captureStderr();
    const received: string[] = [];
    const release = installDiagnosticSink((message) => received.push(message));

    warnError(HOSTILE, new Error('boom'), 'feedback');
    warnStderr(HOSTILE, 'feedback');
    release();

    expect(received).toEqual([`${SANITIZED}: boom`, SANITIZED]);
    expect(stderr).toEqual([]);

    warnStderr('after teardown', 'feedback');
    expect(stderr).toEqual(['after teardown\n']);
    expect(received).toHaveLength(2);
  });

  it('returns ownership to the prior sink on idempotent release in any order', () => {
    const stderr = captureStderr();
    const outer: string[] = [];
    const inner: string[] = [];
    const releaseOuter = installDiagnosticSink((message) => outer.push(message));
    const releaseInner = installDiagnosticSink((message) => inner.push(message));

    warnStderr('to inner', 'feedback');
    releaseInner();
    releaseInner();
    warnStderr('to outer', 'feedback');

    const releaseLate = installDiagnosticSink((message) => inner.push(message));
    releaseOuter();
    releaseOuter();
    warnStderr('to late', 'feedback');
    releaseLate();
    warnStderr('to stderr', 'feedback');

    expect(inner).toEqual(['to inner', 'to late']);
    expect(outer).toEqual(['to outer']);
    expect(stderr).toEqual(['to stderr\n']);
  });

  it('writes a diagnostic with no presentation to the debug log only', () => {
    enableDebugLog(projectDir);
    const stderr = captureStderr();
    const received: [string, string][] = [];
    const release = installDiagnosticSink((message, presentation) =>
      received.push([message, presentation]),
    );

    warnStderr('a');
    warnError('b', new Error('c'));
    release();

    expect(received).toEqual([]);
    expect(stderr).toEqual([]);
    expect(loggedDiagnostics(projectDir)).toEqual(['a', 'b: c']);
  });

  it('writes no stderr line for a diagnostic when no sink is installed', () => {
    const stderr = captureStderr();

    warnStderr('a');

    expect(stderr).toEqual([]);
  });

  it('hands a diagnostic that names its presentation to the sink, and to stderr with no sink', () => {
    const stderr = captureStderr();
    const received: [string, string][] = [];
    const release = installDiagnosticSink((message, presentation) =>
      received.push([message, presentation]),
    );

    warnStderr('a', 'feedback');
    warnStderr('b', 'at-exit');
    release();

    expect(received).toEqual([
      ['a', 'feedback'],
      ['b', 'at-exit'],
    ]);
    expect(stderr).toEqual([]);

    warnStderr('a', 'feedback');

    expect(stderr).toEqual(['a\n']);
    expect(received).toHaveLength(2);
  });

  it('has no hold of early diagnostics', () => {
    expect('withHeldDiagnostics' in warn).toBe(false);
  });

  it('prints nothing when the sink is released', () => {
    const stderr = captureStderr();
    const release = installDiagnosticSink(() => {});

    warnStderr('a');
    warnStderr('b', 'feedback');
    release();

    const second: string[] = [];
    const releaseSecond = installDiagnosticSink((message) => second.push(message));
    releaseSecond();

    expect(stderr).toEqual([]);
    expect(second).toEqual([]);
  });
});

describe('a line break in a warning', () => {
  it('shows as one space on the stderr line, not as nothing', () => {
    const stderr = captureStderr();
    let parseError: unknown;
    try {
      JSON.parse('{"visible": tru\n');
    } catch (err) {
      parseError = err;
    }

    warnError('could not read the saved layout', parseError, 'feedback');

    expect(stderr).toEqual([
      `could not read the saved layout: Unexpected token ' ', "{"visible": tru " is not valid JSON\n`,
    ]);
  });
});
