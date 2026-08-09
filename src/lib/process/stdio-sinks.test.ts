import { describe, it, expect, afterEach } from 'vitest';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProcessOutputSink, matchesStdioSink, stdioSinkKeys } from './stdio-sinks.js';

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function makeTmpFile(name: string): string {
  tmp ??= mkdtempSync(join(tmpdir(), 'stdio-sinks-'));
  const path = join(tmp, name);
  writeFileSync(path, 'seed\n');
  return path;
}

describe('stdioSinkKeys', () => {
  it('keys an fd that points at a regular file', () => {
    const sink = makeTmpFile('run.ndjson');
    const fd = openSync(sink, 'a');
    const keys = stdioSinkKeys([fd]);
    closeSync(fd);
    expect(keys.size).toBe(1);
  });

  it('ignores closed or invalid fds', () => {
    expect(stdioSinkKeys([987654]).size).toBe(0);
  });
});

describe('matchesStdioSink', () => {
  it('matches the redirect target by file identity, not by name', () => {
    const sink = makeTmpFile('run.ndjson');
    const other = makeTmpFile('other.ndjson');
    const fd = openSync(sink, 'a');
    const keys = stdioSinkKeys([fd]);
    closeSync(fd);

    expect(matchesStdioSink(keys, sink)).toBe(true);
    expect(matchesStdioSink(keys, other)).toBe(false);
  });

  it('returns false for an empty key set and for a missing path', () => {
    const sink = makeTmpFile('run.ndjson');
    expect(matchesStdioSink(new Set<string>(), sink)).toBe(false);

    const fd = openSync(sink, 'a');
    const keys = stdioSinkKeys([fd]);
    closeSync(fd);
    expect(matchesStdioSink(keys, join(tmp ?? '', 'does-not-exist'))).toBe(false);
  });
});

describe('isProcessOutputSink', () => {
  it('does not claim an ordinary project file', () => {
    expect(isProcessOutputSink(makeTmpFile('ordinary.ts'))).toBe(false);
  });
});
