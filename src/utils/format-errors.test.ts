import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { labelError, toErrorMessage } from './format-errors.js';

const fileError = (message: string, fields: Record<string, string>) =>
  Object.assign(new Error(message), fields);

describe('toErrorMessage', () => {
  const sessions = join(process.cwd(), '.splitbrief', 'sessions', 'a');

  test.each([
    ['open', 'EACCES', 'permission denied', 'plan.json'],
    ['open', 'ENOSPC', 'no space left on device', 'review-packet.json'],
    ['mkdir', 'EROFS', 'read-only file system', 'drift.json'],
    ['open', 'EACCES', 'permission denied', 'Cargo.lock'],
    ['open', 'EACCES', 'permission denied', 'gems.rb.lock'],
  ])(
    'spells a failed %s as its words and the file, project-relative',
    (syscall, code, words, name) => {
      const path = join(sessions, name);
      expect(
        toErrorMessage(
          fileError(`${code}: ${words}, ${syscall} '${path}'`, { code, syscall, path }),
        ),
      ).toBe(`${words} · ${join('.splitbrief', 'sessions', 'a', name)}`);
    },
  );

  test('keeps a file outside the project absolute', () => {
    const path = '/elsewhere/state.json';
    expect(
      toErrorMessage(
        fileError(`EACCES: permission denied, open '${path}'`, { code: 'EACCES', path }),
      ),
    ).toBe('permission denied · /elsewhere/state.json');
  });

  test.each([
    ['rename', 'EACCES', 'permission denied', '.Cargo.lock.tmp.ab12', 'Cargo.lock'],
    ['symlink', 'EEXIST', 'file already exists', 'node_modules', 'link'],
  ])('names the file a failed %s makes', (syscall, code, words, path, dest) => {
    const at = (name: string) => join(sessions, name);
    expect(
      toErrorMessage(
        fileError(`${code}: ${words}, ${syscall} '${at(path)}' -> '${at(dest)}'`, {
          code,
          syscall,
          path: at(path),
          dest: at(dest),
        }),
      ),
    ).toBe(`${words} · ${join('.splitbrief', 'sessions', 'a', dest)}`);
  });

  test.each([
    ['ENOSPC', 'no space left on device', 'write'],
    ['EFBIG', 'file too large', 'write'],
    ['EIO', 'i/o error', 'fsync'],
  ])('spells a failed %s with no file as its words alone', (code, words, syscall) => {
    expect(toErrorMessage(fileError(`${code}: ${words}, ${syscall}`, { code, syscall }))).toBe(
      words,
    );
  });

  test.each([
    [
      'a tool that is not installed',
      fileError('spawn claude ENOENT', { code: 'ENOENT', syscall: 'spawn claude', path: 'claude' }),
    ],
    ['an error that is not a file error', new Error('planner down')],
  ])('keeps the message of %s', (_label, err) => {
    expect(toErrorMessage(err)).toBe(err.message);
  });

  test('keeps a value that is not an error', () => {
    expect(toErrorMessage('plain words')).toBe('plain words');
  });

  test('labelError puts the action before the spelled file error', () => {
    const path = join(sessions, 'plan.json');
    expect(
      labelError(
        'Planning failed',
        fileError(`EACCES: permission denied, open '${path}'`, { code: 'EACCES', path }),
      ),
    ).toBe(
      `Planning failed: permission denied · ${join('.splitbrief', 'sessions', 'a', 'plan.json')}`,
    );
    expect(
      labelError(
        'Review packet generation failed',
        fileError('ENOSPC: no space left on device, write', { code: 'ENOSPC', syscall: 'write' }),
      ),
    ).toBe('Review packet generation failed: no space left on device');
  });
});
