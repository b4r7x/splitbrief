// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { MIN_OG_BYTES, validateOgPng } from './validate-og.js';

function pngHeader(width: number, height: number): Buffer {
  const image = Buffer.alloc(MIN_OG_BYTES);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.write('IHDR', 12, 'ascii');
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

describe('reviewed Open Graph image', () => {
  it('accepts a nonempty 1200x630 PNG', () => {
    expect(() => validateOgPng(pngHeader(1_200, 630))).not.toThrow();
  });

  it('rejects empty and malformed input', () => {
    expect(() => validateOgPng(Buffer.alloc(0))).toThrow(/nonempty/);
    expect(() => validateOgPng(Buffer.alloc(MIN_OG_BYTES))).toThrow(/valid PNG/);
  });

  it('rejects unexpected dimensions', () => {
    expect(() => validateOgPng(pngHeader(1_200, 600))).toThrow(/1200x630/);
  });
});
