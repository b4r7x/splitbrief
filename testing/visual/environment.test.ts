import { describe, expect, it, vi } from 'vitest';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { inCaptureOrder, withCaptureEnvironment } from './gallery/environment.js';

const VIEWPORT = { cols: 80, rows: 24 } as const;
const ENV_KEYS = [
  'TZ',
  'LANG',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'FORCE_HYPERLINK',
  'NO_COLOR',
  'DIPTYCH_VISUAL_MOTION',
] as const;

function environmentSnapshot(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

async function diagnosticBytes(): Promise<string> {
  return withCaptureEnvironment({ viewport: VIEWPORT }, ({ determinism }) =>
    JSON.stringify({
      determinism,
      now: Date.now(),
      random: [Math.random(), Math.random(), Math.random()],
      terminal: terminalSizeStore.get(),
      order: inCaptureOrder(['zeta', 'alpha', 'alpha'], (value) => value),
    }),
  );
}

describe('visual capture environment', () => {
  it('produces byte-equivalent diagnostics for repeated runs', async () => {
    expect(await diagnosticBytes()).toBe(await diagnosticBytes());
  });

  it.each([
    ['success', () => Promise.resolve('ok')],
    ['timeout', () => Promise.reject(new Error('bounded timeout'))],
    ['fixture error', () => Promise.reject(new Error('fixture failed'))],
  ])('restores globals and environment after %s', async (_name, operation) => {
    const environment = environmentSnapshot();
    const dateNow = Date.now;
    const random = Math.random;
    const terminal = terminalSizeStore.get();
    const columns = process.stdout.columns;
    const rows = process.stdout.rows;

    await withCaptureEnvironment({ viewport: VIEWPORT }, operation).catch(() => undefined);

    expect(environmentSnapshot()).toEqual(environment);
    expect(Date.now).toBe(dateNow);
    expect(Math.random).toBe(random);
    expect(terminalSizeStore.get()).toEqual(terminal);
    expect(process.stdout.columns).toBe(columns);
    expect(process.stdout.rows).toBe(rows);
  });

  it('does not write terminal setup sequences and restores idempotently', async () => {
    const write = vi.spyOn(process.stdout, 'write');

    await withCaptureEnvironment({ viewport: VIEWPORT }, (scope) => {
      scope.restore();
      scope.restore();
    });

    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});
