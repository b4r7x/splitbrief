import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./start-time.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./start-time.js')>();
  return { ...actual, readProcessStartTimeMs: vi.fn(actual.readProcessStartTimeMs) };
});

import { checkProcessIdentity, probePid, startTimeMatches } from './liveness.js';
import { currentProcessStartTimeMs, readProcessStartTimeMs } from './start-time.js';

const OTHER_PID = 4242;

function killFails(code: string): void {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    const err: NodeJS.ErrnoException = new Error(`kill ${code}`);
    err.code = code;
    throw err;
  });
}

function killSucceeds(): void {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startTimeMatches', () => {
  it('matches start times up to 2000 ms apart in either direction', () => {
    expect(startTimeMatches(10_000, 10_000)).toBe(true);
    expect(startTimeMatches(10_000, 12_000)).toBe(true);
    expect(startTimeMatches(12_000, 10_000)).toBe(true);
  });

  it('does not match start times 2001 ms apart', () => {
    expect(startTimeMatches(10_000, 12_001)).toBe(false);
    expect(startTimeMatches(12_001, 10_000)).toBe(false);
  });
});

describe('checkProcessIdentity', () => {
  it('reads this process with its own start time as live', () => {
    expect(checkProcessIdentity(process.pid, currentProcessStartTimeMs())).toBe('live');
  });

  it('reads a pid whose process started 2000 ms from the expected time as live', () => {
    vi.mocked(readProcessStartTimeMs).mockReturnValueOnce(100_000);

    expect(checkProcessIdentity(OTHER_PID, 102_000)).toBe('live');
  });

  it('reads a pid whose process started 2001 ms from the expected time as pid-reused', () => {
    vi.mocked(readProcessStartTimeMs).mockReturnValueOnce(100_000);

    expect(checkProcessIdentity(OTHER_PID, 102_001)).toBe('pid-reused');
  });

  it('probes the pid when its start time cannot be read', () => {
    vi.mocked(readProcessStartTimeMs).mockReturnValueOnce(null);
    killFails('ESRCH');

    expect(checkProcessIdentity(OTHER_PID, 100_000)).toBe('dead');
  });

  it('probes the pid when the expected start time is not a finite number', () => {
    vi.mocked(readProcessStartTimeMs).mockReturnValueOnce(100_000);
    killSucceeds();

    expect(checkProcessIdentity(OTHER_PID, Number.NaN)).toBe('unknown');
  });
});

describe('probePid', () => {
  it('reads a pid that takes signal 0 as unknown', () => {
    killSucceeds();

    expect(probePid(OTHER_PID)).toBe('unknown');
  });

  it('reads a pid with no process as dead', () => {
    killFails('ESRCH');

    expect(probePid(OTHER_PID)).toBe('dead');
  });

  it('reads a pid of another user as unknown', () => {
    killFails('EPERM');

    expect(probePid(OTHER_PID)).toBe('unknown');
  });
});
