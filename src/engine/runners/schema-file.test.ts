import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withSchemaFile } from './schema-file.js';

describe('withSchemaFile', () => {
  it('writes the schema as a private 0600 file for the callback', async () => {
    let path = '';
    await withSchemaFile({ type: 'object' }, async (file) => {
      path = file;
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('{"type":"object"}');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  it('returns the callback result and removes the directory', async () => {
    let path = '';
    await expect(
      withSchemaFile({ type: 'object' }, async (file) => {
        path = file;
        return 'done';
      }),
    ).resolves.toBe('done');
    expect(existsSync(dirname(path))).toBe(false);
  });

  it('propagates the callback error and removes the directory', async () => {
    let path = '';
    await expect(
      withSchemaFile({ type: 'object' }, async (file) => {
        path = file;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(dirname(path))).toBe(false);
  });
});
