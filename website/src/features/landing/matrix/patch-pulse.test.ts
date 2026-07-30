import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PATCH_PULSE_MS } from './matrix-state.js';

describe('patch pulse timing', () => {
  it('keeps the final delayed animation within the state transition window', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/features/landing/matrix/patch-pulse.css'),
      {
        encoding: 'utf8',
      },
    );
    const duration = Number(/--matrix-pulse-duration:\s*(\d+)ms/.exec(css)?.[1]);
    const delays = [...css.matchAll(/animation-delay:\s*(\d+)ms/g)].map((match) =>
      Number(match[1]),
    );

    expect(duration).toBe(140);
    expect(Math.max(...delays) + duration).toBe(PATCH_PULSE_MS);
  });
});
