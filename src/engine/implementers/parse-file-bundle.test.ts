import { describe, expect, it } from 'vitest';
import type { BundleBaseline } from './file-bundle.js';
import {
  FILE_BUNDLE_MAX_FILE_BYTES,
  FILE_BUNDLE_MAX_RESPONSE_BYTES,
  parseFileBundle,
  type ParseFileBundleResult,
} from './parse-file-bundle.js';

const A = 'src/a.ts';
const B = 'src/b.ts';
const BASE_A = 'export const a = 1;\n';

function modifyTarget(path: string, content: string): BundleBaseline {
  return { path, operation: 'modify', kind: 'text', content, sha256: 'a'.repeat(64), mode: 0o644 };
}

function createTarget(path: string): BundleBaseline {
  return { path, operation: 'create', kind: 'missing' };
}

const targets = [modifyTarget(A, BASE_A), createTarget(B)];

function parse(text: string, overrides: Partial<Parameters<typeof parseFileBundle>[0]> = {}) {
  return parseFileBundle({ text, status: 'completed', targets, scope: [A, B], ...overrides });
}

function bundleText(files: unknown[], version: unknown = 1): string {
  return JSON.stringify({ version, files });
}

function expectRejected(
  result: ParseFileBundleResult,
  code: 'invalid-bundle' | 'unsafe-target' | 'output-limit' | 'no-changes',
): void {
  expect(result.kind).toBe('rejected');
  expect(result.kind === 'rejected' ? result.code : undefined).toBe(code);
  expect('candidates' in result).toBe(false);
}

describe('parseFileBundle accepts', () => {
  it('a mixed create and modify bundle as ordered candidates', () => {
    const result = parse(
      bundleText([
        { path: B, action: 'create', content: 'export const b = 2;\n' },
        { path: A, action: 'modify', content: 'export const a = 9;\n' },
      ]),
    );
    expect(result).toEqual({
      kind: 'parsed',
      candidates: [
        { path: A, action: 'modify', content: 'export const a = 9;\n' },
        { path: B, action: 'create', content: 'export const b = 2;\n' },
      ],
      noops: [],
      untouched: [],
    });
  });

  it('one whole json fence with only outer whitespace', () => {
    const json = bundleText([{ path: B, action: 'create', content: 'x\n' }]);
    const result = parse(`\n\n\`\`\`json\n${json}\n\`\`\`\n`);
    expect(result.kind === 'parsed' && result.candidates).toEqual([
      { path: B, action: 'create', content: 'x\n' },
    ]);
  });

  it('a raw object with surrounding whitespace and a one-file bundle', () => {
    const result = parse(`  \n${bundleText([{ path: A, action: 'modify', content: 'new\n' }])}\n `);
    expect(result.kind === 'parsed' && result.candidates).toHaveLength(1);
  });

  it('empty content as a complete file, retained verbatim', () => {
    const result = parse(bundleText([{ path: B, action: 'create', content: '' }]));
    expect(result.kind === 'parsed' && result.candidates).toEqual([
      { path: B, action: 'create', content: '' },
    ]);
  });

  it('an omitted declared target as untouched rather than deleted', () => {
    const result = parse(bundleText([{ path: A, action: 'modify', content: 'changed\n' }]));
    expect(result.kind === 'parsed' && result.untouched).toEqual([B]);
  });

  it('an identical modify entry as a no-op beside a real change', () => {
    const result = parse(
      bundleText([
        { path: A, action: 'modify', content: BASE_A },
        { path: B, action: 'create', content: 'b\n' },
      ]),
    );
    expect(result.kind === 'parsed' && result).toMatchObject({
      candidates: [{ path: B, action: 'create', content: 'b\n' }],
      noops: [A],
      untouched: [],
    });
  });
});

describe('parseFileBundle accepts a blocked response', () => {
  const blockedText = (question: string, filesNeeded: string[]): string =>
    JSON.stringify({ version: 1, blocked: { question, filesNeeded } });

  it('returns the question and the files it needs, with no candidates', () => {
    const result = parse(blockedText('Which store should the cache use?', ['src/store.ts']));
    expect(result).toEqual({
      kind: 'blocked',
      question: 'Which store should the cache use?',
      filesNeeded: ['src/store.ts'],
    });
  });

  it('does not validate the needed files against the declared targets', () => {
    const needed = ['tests/fixtures/missing.json'];
    const result = parse(blockedText('May I read the fixture?', needed));
    expect(result.kind === 'blocked' && result.filesNeeded).toEqual(needed);
  });

  it('rejects unknown or missing blocked fields, a wrong version and a mixed two-form object', () => {
    expectRejected(
      parse(JSON.stringify({ version: 1, blocked: { question: 'q' } })),
      'invalid-bundle',
    );
    expectRejected(
      parse(JSON.stringify({ version: 1, blocked: { question: 'q', filesNeeded: [], note: 'x' } })),
      'invalid-bundle',
    );
    expectRejected(
      parse(JSON.stringify({ version: 2, blocked: { question: 'q', filesNeeded: [] } })),
      'invalid-bundle',
    );
    expectRejected(
      parse(
        JSON.stringify({
          version: 1,
          files: [{ path: A, action: 'modify', content: 'x\n' }],
          blocked: { question: 'q', filesNeeded: [] },
        }),
      ),
      'invalid-bundle',
    );
  });

  it('still checks the frame and the transport status first', () => {
    expectRejected(parse(`Here is my answer:\n${blockedText('q', [])}`), 'invalid-bundle');
    expectRejected(parse(blockedText('q', []), { status: 'aborted' }), 'invalid-bundle');
  });
});

describe('parseFileBundle rejects the response frame', () => {
  it('incomplete JSON, without repairing it', () => {
    expectRejected(
      parse('{"version":1,"files":[{"path":"src/a.ts","action":"modify","co'),
      'invalid-bundle',
    );
  });

  it('prose around an otherwise valid bundle', () => {
    const json = bundleText([{ path: A, action: 'modify', content: 'x\n' }]);
    expectRejected(parse(`Here is the bundle:\n${json}\n`), 'invalid-bundle');
    expectRejected(parse(`${json}\nLet me know if you want more.`), 'invalid-bundle');
  });

  it('a trailing second object', () => {
    const json = bundleText([{ path: A, action: 'modify', content: 'x\n' }]);
    expectRejected(parse(`${json}\n${json}`), 'invalid-bundle');
  });

  it('two fences rather than extracting the longest one', () => {
    const json = bundleText([{ path: A, action: 'modify', content: 'x\n' }]);
    expectRejected(parse(`\`\`\`json\n{}\n\`\`\`\n\`\`\`json\n${json}\n\`\`\``), 'invalid-bundle');
  });

  it('a fence that is not opened with the literal json tag', () => {
    const json = bundleText([{ path: A, action: 'modify', content: 'x\n' }]);
    expectRejected(parse(`\`\`\`\n${json}\n\`\`\``), 'invalid-bundle');
  });

  it('a complete-looking JSON body that the transport refused or truncated', () => {
    const json = bundleText([{ path: A, action: 'modify', content: 'x\n' }]);
    for (const status of ['refused', 'truncated', 'aborted', 'timeout', 'failed'] as const) {
      expectRejected(parse(json, { status }), 'invalid-bundle');
    }
  });
});

describe('parseFileBundle rejects the bundle shape', () => {
  it('a version other than 1', () => {
    expectRejected(
      parse(bundleText([{ path: A, action: 'modify', content: 'x\n' }], 2)),
      'invalid-bundle',
    );
  });

  it('an action other than create or modify', () => {
    for (const action of ['delete', 'rename', 'chmod']) {
      expectRejected(parse(bundleText([{ path: A, action, content: '' }])), 'invalid-bundle');
    }
  });

  it('an unknown key and an empty file list', () => {
    expectRejected(
      parse(bundleText([{ path: A, action: 'modify', content: 'x\n', mode: 420 }])),
      'invalid-bundle',
    );
    expectRejected(parse(bundleText([])), 'invalid-bundle');
  });

  it('an action that disagrees with the captured baseline operation', () => {
    expectRejected(
      parse(bundleText([{ path: A, action: 'create', content: 'x\n' }])),
      'invalid-bundle',
    );
    expectRejected(
      parse(bundleText([{ path: B, action: 'modify', content: 'x\n' }])),
      'invalid-bundle',
    );
  });
});

describe('parseFileBundle rejects unsafe targets', () => {
  it('duplicate canonical paths', () => {
    expectRejected(
      parse(
        bundleText([
          { path: A, action: 'modify', content: 'one\n' },
          { path: A, action: 'modify', content: 'two\n' },
        ]),
      ),
      'unsafe-target',
    );
  });

  it('absolute, drive, backslash, dot-segment and NUL spellings', () => {
    for (const path of [
      `/${A}`,
      'C:/src/a.ts',
      'src\\a.ts',
      `./${A}`,
      'src/../src/a.ts',
      'src/\0a.ts',
      '',
    ]) {
      expectRejected(
        parse(bundleText([{ path, action: 'modify', content: 'x\n' }])),
        'unsafe-target',
      );
    }
  });

  it('a target that is an ancestor of another entry', () => {
    const nested = [modifyTarget('src', 'dir\n'), createTarget('src/nested.ts')];
    expectRejected(
      parse(
        bundleText([
          { path: 'src', action: 'modify', content: 'x\n' },
          { path: 'src/nested.ts', action: 'create', content: 'y\n' },
        ]),
        { targets: nested, scope: ['src', 'src/nested.ts'] },
      ),
      'unsafe-target',
    );
  });

  it('a path that was never captured, or is captured but outside the declared scope', () => {
    expectRejected(
      parse(bundleText([{ path: 'src/c.ts', action: 'create', content: 'x\n' }])),
      'unsafe-target',
    );
    expectRejected(
      parse(bundleText([{ path: B, action: 'create', content: 'x\n' }]), { scope: [A] }),
      'unsafe-target',
    );
  });

  it('a forbidden second entry, leaving zero applicable candidates from a valid first one', () => {
    const result = parse(
      bundleText([
        { path: A, action: 'modify', content: 'legitimate\n' },
        { path: 'package.json', action: 'modify', content: '{}\n' },
      ]),
    );
    expectRejected(result, 'unsafe-target');
    expect(result.kind === 'rejected' && result.error).toContain('package.json');
  });
});

describe('parseFileBundle rejects unsafe or oversized content', () => {
  it('an embedded NUL byte', () => {
    expectRejected(
      parse(bundleText([{ path: A, action: 'modify', content: 'a\0b' }])),
      'invalid-bundle',
    );
  });

  it('a lone Unicode surrogate', () => {
    expectRejected(
      parse(bundleText([{ path: A, action: 'modify', content: `a\uD800b` }])),
      'invalid-bundle',
    );
    expectRejected(
      parse(bundleText([{ path: A, action: 'modify', content: `a\uDC00b` }])),
      'invalid-bundle',
    );
  });

  it('more than a mebibyte of UTF-8 in one file', () => {
    const content = 'é'.repeat(FILE_BUNDLE_MAX_FILE_BYTES / 2 + 1);
    expectRejected(parse(bundleText([{ path: A, action: 'modify', content }])), 'output-limit');
  });

  it('a raw response above the total response limit before it parses anything', () => {
    expectRejected(parse('x'.repeat(FILE_BUNDLE_MAX_RESPONSE_BYTES + 1)), 'output-limit');
  });
});

describe('parseFileBundle rejects a bundle that changes nothing', () => {
  it('reports no-changes when every entry equals its baseline', () => {
    const result = parse(bundleText([{ path: A, action: 'modify', content: BASE_A }]), {
      targets: [modifyTarget(A, BASE_A)],
      scope: [A],
    });
    expectRejected(result, 'no-changes');
  });
});
