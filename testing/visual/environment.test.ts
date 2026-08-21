import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { createElement } from 'react';
import { glyph } from '../../src/lib/glyphs.js';
import { terminalSizeStore } from '../../src/stores/ui/terminal-size.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { renderFeature } from '#testing/helpers/ink.js';
import { inCaptureOrder, withCaptureEnvironment } from './gallery/environment.js';

const VIEWPORT = { cols: 80, rows: 24 } as const;
const PROFILES = ['unicode-color', 'unicode-mono', 'ascii-mono'] as const;
const ENV_KEYS = [
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'FORCE_COLOR',
  'FORCE_HYPERLINK',
  'NO_COLOR',
  'SPLITBRIEF_VISUAL_MOTION',
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
    ['generic rejection', () => Promise.reject(new Error('capture failed'))],
  ])('restores globals and environment after %s', async (_name, operation) => {
    const environment = environmentSnapshot();
    const dateNow = Date.now;
    const random = Math.random;
    const terminal = terminalSizeStore.get();
    const columns = process.stdout.columns;
    const rows = process.stdout.rows;
    const isTTY = process.stdout.isTTY;

    await withCaptureEnvironment({ viewport: VIEWPORT }, operation).catch(() => undefined);

    expect(environmentSnapshot()).toEqual(environment);
    expect(Date.now).toBe(dateNow);
    expect(Math.random).toBe(random);
    expect(terminalSizeStore.get()).toEqual(terminal);
    expect(process.stdout.columns).toBe(columns);
    expect(process.stdout.rows).toBe(rows);
    expect(process.stdout.isTTY).toBe(isTTY);
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

  it.each(PROFILES)('keeps %s output homogeneous and geometry stable', async (profile) => {
    const rendered = await withCaptureEnvironment({ viewport: VIEWPORT, profile }, () => {
      const ui = renderFeature(
        createElement(
          Text,
          { color: 'red' },
          `CONTRACT BLOCKED | BECAUSE QUALITY | NOW retry ${glyph('check')}`,
        ),
        VIEWPORT,
      );
      const frame = ui.lastFrame();
      ui.unmount();
      return {
        frame,
        geometry: frame.split('\n').map((line) => stripAnsiStyles(line).length),
        terminal: terminalSizeStore.get(),
        columns: process.stdout.columns,
        rows: process.stdout.rows,
        glyph: glyph('check'),
      };
    });

    expect(rendered.terminal).toMatchObject({ cols: VIEWPORT.cols, rows: VIEWPORT.rows });
    expect(rendered.columns).toBe(VIEWPORT.cols);
    expect(rendered.rows).toBe(VIEWPORT.rows);
    expect(rendered.frame).toContain('CONTRACT BLOCKED');
    expect(rendered.frame).toContain('BECAUSE QUALITY');
    expect(rendered.frame).toContain('NOW retry');
    expect(rendered.geometry).toEqual(['CONTRACT BLOCKED | BECAUSE QUALITY | NOW retry ✓'.length]);
    if (profile === 'ascii-mono') {
      expect(rendered.frame).toBe(stripAnsiStyles(rendered.frame));
      expect([...rendered.glyph].every((character) => character.charCodeAt(0) < 128)).toBe(true);
      expect([...rendered.frame].every((character) => character.charCodeAt(0) < 128)).toBe(true);
    } else {
      expect(rendered.glyph).toBe('✓');
    }
    if (profile === 'unicode-mono') {
      expect(rendered.frame).toBe(stripAnsiStyles(rendered.frame));
    }
  });

  it.each(PROFILES)('restores nested %s success and failure scopes exactly', async (profile) => {
    const before = environmentSnapshot();
    const dateNow = Date.now;
    const random = Math.random;
    const terminal = terminalSizeStore.get();
    const columns = process.stdout.columns;
    const rows = process.stdout.rows;
    const isTTY = process.stdout.isTTY;

    await withCaptureEnvironment({ viewport: VIEWPORT, profile }, async (outer) => {
      const outerEnvironment = environmentSnapshot();
      const outerDateNow = Date.now;
      const outerRandom = Math.random;
      const outerTerminal = terminalSizeStore.get();

      await withCaptureEnvironment({ viewport: VIEWPORT, profile }, (inner) => {
        expect(inner.determinism).toEqual(outer.determinism);
        expect(environmentSnapshot()).toEqual(outerEnvironment);
        expect(terminalSizeStore.get()).toEqual(outerTerminal);
      });
      expect(environmentSnapshot()).toEqual(outerEnvironment);
      expect(Date.now).toBe(outerDateNow);
      expect(Math.random).toBe(outerRandom);
      expect(terminalSizeStore.get()).toEqual(outerTerminal);

      await expect(
        withCaptureEnvironment({ viewport: VIEWPORT, profile }, () => {
          throw new Error('nested capture failed');
        }),
      ).rejects.toThrow('nested capture failed');
      expect(environmentSnapshot()).toEqual(outerEnvironment);
      outer.restore();
      outer.restore();
    });

    expect(environmentSnapshot()).toEqual(before);
    expect(Date.now).toBe(dateNow);
    expect(Math.random).toBe(random);
    expect(terminalSizeStore.get()).toEqual(terminal);
    expect(process.stdout.columns).toBe(columns);
    expect(process.stdout.rows).toBe(rows);
    expect(process.stdout.isTTY).toBe(isTTY);
  });
});
