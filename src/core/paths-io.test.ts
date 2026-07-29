import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureSplitbriefDir,
  ensureSessionDir,
  writeSpecFile,
  readSpecFile,
  readSpecFileOrEmpty,
  validateFilename,
} from './paths-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR, sessionDir } from './paths.js';

let tmp: string;
const SESSION_ID = '2024-01-01-test-feature';
const itUnix = process.platform === 'win32' ? it.skip : it;

function makeTmp(): string {
  tmp = createTempDir('paths-io-test');
  return tmp;
}

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
});

describe('ensureSplitbriefDir', () => {
  it('creates the directory and is idempotent', () => {
    const dir = makeTmp();
    ensureSplitbriefDir(dir);
    expect(existsSync(join(dir, SPLITBRIEF_DIR))).toBe(true);
    ensureSplitbriefDir(dir);
    expect(existsSync(join(dir, SPLITBRIEF_DIR))).toBe(true);
  });
});

describe('ensureSessionDir', () => {
  it('creates the directory and is idempotent', () => {
    const dir = makeTmp();
    ensureSessionDir(dir, SESSION_ID);
    expect(existsSync(join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID))).toBe(true);
    ensureSessionDir(dir, SESSION_ID);
    expect(existsSync(join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID))).toBe(true);
  });

  it('rejects session ids with path traversal', () => {
    const dir = makeTmp();
    expect(() => ensureSessionDir(dir, '../outside')).toThrow('Invalid session id');
  });
});

describe('sessionDir', () => {
  it('rejects empty session ids', () => {
    const dir = makeTmp();
    expect(() => sessionDir(dir, '')).toThrow("Invalid session id ''");
  });

  it('rejects session ids with separators', () => {
    const dir = makeTmp();
    expect(() => sessionDir(dir, 'nested/session')).toThrow('Invalid session id');
    expect(() => sessionDir(dir, 'nested\\session')).toThrow('Invalid session id');
  });

  it('rejects session ids that resolve to the sessions root or inject active-file lines', () => {
    const dir = makeTmp();
    expect(() => sessionDir(dir, '.')).toThrow('Invalid session id');
    expect(() => sessionDir(dir, 'session\nother')).toThrow('Invalid session id');
  });
});

describe('writeSpecFile', () => {
  it('writes content to .splitbrief/sessions/<id>/<filename>', () => {
    const dir = makeTmp();
    writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md', '# Spec');
    const written = join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'spec.md');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toBe('# Spec');
  });

  it('rejects filenames with path traversal', () => {
    const dir = makeTmp();
    expect(() =>
      writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, '../outside.md', 'x'),
    ).toThrow('Invalid filename');
  });
});

describe('readSpecFile', () => {
  it('reads content from .splitbrief/sessions/<id>/<filename>', () => {
    const dir = makeTmp();
    writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'tasks.md', '- task 1');
    expect(readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'tasks.md')).toBe('- task 1');
  });

  it('returns null when file does not exist', () => {
    const dir = makeTmp();
    ensureSessionDir(dir, SESSION_ID);
    expect(readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'missing.md')).toBeNull();
  });

  it('rejects filenames with path traversal', () => {
    const dir = makeTmp();
    expect(() => readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, '../outside.md')).toThrow(
      'Invalid filename',
    );
  });

  itUnix('rejects reading session artifacts through final symlinks', () => {
    const dir = makeTmp();
    const outside = createTempDir('paths-io-spec-outside');
    try {
      ensureSessionDir(dir, SESSION_ID);
      writeFileSync(join(outside, 'secret.md'), 'outside spec');
      symlinkSync(
        join(outside, 'secret.md'),
        join(dir, SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_ID, 'spec.md'),
      );

      expect(() => readSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md')).toThrow(
        /unsafe path/,
      );
    } finally {
      cleanupTempDir(outside);
    }
  });
});

describe('readSpecFileOrEmpty', () => {
  it('returns content for an existing file', () => {
    const dir = makeTmp();
    writeSpecFile({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md', '# My Spec');
    expect(readSpecFileOrEmpty({ projectDir: dir, sessionId: SESSION_ID }, 'spec.md')).toBe(
      '# My Spec',
    );
  });

  it('returns empty string for a non-existent file', () => {
    const dir = makeTmp();
    ensureSessionDir(dir, SESSION_ID);
    expect(readSpecFileOrEmpty({ projectDir: dir, sessionId: SESSION_ID }, 'missing.md')).toBe('');
  });
});

describe('validateFilename', () => {
  it('accepts a plain filename', () => {
    expect(() => validateFilename('spec.md')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateFilename('')).toThrow("Invalid filename ''");
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateFilename('   ')).toThrow('Invalid filename');
  });

  it('rejects filenames with ..', () => {
    expect(() => validateFilename('../etc/passwd')).toThrow('Invalid filename');
  });

  it('rejects filenames with forward slash', () => {
    expect(() => validateFilename('sub/spec.md')).toThrow('Invalid filename');
  });

  it('rejects filenames with backslash', () => {
    expect(() => validateFilename('sub\\spec.md')).toThrow('Invalid filename');
  });
});
