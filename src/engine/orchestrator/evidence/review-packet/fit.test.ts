import { describe, expect, it } from 'vitest';
import {
  buildFinalReviewPrompt,
  type FinalReviewPromptInput,
} from '../../../spec/prompts/review.js';
import type { PromptLimit } from '../../../runners/input-limit.js';
import { fallbackInstruction } from '../../../runners/typed-output.js';
import { REVIEW_ANSWER_JSON_SCHEMA } from '../../../../core/schemas/review.js';
import { fitReviewPrompt } from './fit.js';

const PREFIX = 'Read the workspace at /tmp/ws.\n\n';
const EVIDENCE = {
  validation: '/tmp/session/evidence.json',
  sessionLog: '/tmp/session/session.jsonl',
  drift: '/tmp/session/drift-report.json',
};
const declared = (path: string): boolean => path.startsWith('src/declared');

function modified(path: string, body: string) {
  return {
    path,
    taskIds: ['T001'],
    diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${body}\n`,
  };
}

function created(path: string, body: string) {
  return {
    path,
    taskIds: ['T001'],
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${body}\n`,
  };
}

function input(overrides: Partial<FinalReviewPromptInput>): FinalReviewPromptInput {
  return {
    spec: 'Add the feature.',
    taskBriefs: 'T001: add the feature.',
    files: [],
    ...overrides,
  };
}

function chars(max: number): PromptLimit {
  return { max, unit: 'characters' };
}

function fitPrompt(prompt: FinalReviewPromptInput, limit: PromptLimit | undefined, suffix = '') {
  return fitReviewPrompt({
    prefix: PREFIX,
    prompt,
    limit,
    suffix,
    declared,
    evidencePaths: EVIDENCE,
  });
}

describe('fitReviewPrompt', () => {
  it('leaves a prompt untouched when the seat has no cap or the prompt is under it', () => {
    const prompt = input({ files: [modified('src/declared.ts', 'a'.repeat(5_000))] });
    const whole = PREFIX + buildFinalReviewPrompt(prompt);
    for (const limit of [undefined, chars(whole.length)]) {
      const result = fitPrompt(prompt, limit);
      expect(result).toMatchObject({ kind: 'fits', prompt: whole, size: whole.length });
      expect(result.kind === 'fits' && result.dropped).toEqual([]);
    }
  });

  it('drops whole-file bodies first and stops as soon as the prompt fits', () => {
    const result = fitPrompt(
      input({
        files: [
          created('src/declared-new.ts', 'x'.repeat(15_000)),
          modified('src/other.ts', 'y'.repeat(3_000)),
        ],
      }),
      chars(10_000),
    );
    if (result.kind !== 'fits') throw new Error(`expected a fit, got ${result.kind}`);
    expect(result.prompt.length).toBeLessThanOrEqual(10_000);
    expect(result.size).toBe(result.prompt.length);
    expect(result.prompt).not.toContain('x'.repeat(100));
    expect(result.prompt).toContain('y'.repeat(3_000));
    expect(result.dropped).toEqual([{ trim: 'full-file-context', items: ['src/declared-new.ts'] }]);
    expect(result.prompt).toContain('## Trimmed for Size');
    expect(result.prompt.split('## Trimmed for Size')[1]).toContain('src/declared-new.ts');
  });

  it('then drops the diffs of files no brief declares, after the whole-file bodies', () => {
    const result = fitPrompt(
      input({
        files: [
          created('src/declared-new.ts', 'x'.repeat(15_000)),
          modified('src/declared.ts', 'd'.repeat(2_000)),
          modified('src/other.ts', 'y'.repeat(15_000)),
        ],
        workspaceContext: [{ ...modified('docs/notes.md', 'z'.repeat(3_000)), taskIds: [] }],
      }),
      chars(10_000),
    );
    if (result.kind !== 'fits') throw new Error(`expected a fit, got ${result.kind}`);
    expect(result.prompt.length).toBeLessThanOrEqual(10_000);
    expect(result.dropped.map((drop) => drop.trim)).toEqual([
      'full-file-context',
      'undeclared-file-diffs',
    ]);
    expect(result.dropped[1]?.items).toEqual(['src/other.ts', 'docs/notes.md']);
    expect(result.prompt).toContain('d'.repeat(2_000));
    expect(result.prompt).not.toContain('y'.repeat(100));
    expect(result.prompt).not.toContain('z'.repeat(100));
  });

  it('then drops the per-task evidence and names where it is recorded', () => {
    const result = fitPrompt(
      input({
        files: [modified('src/declared.ts', 'd'.repeat(2_000))],
        checksLog: 'v'.repeat(15_000),
        driftReport: 'r'.repeat(200),
      }),
      chars(10_000),
    );
    if (result.kind !== 'fits') throw new Error(`expected a fit, got ${result.kind}`);
    expect(result.prompt.length).toBeLessThanOrEqual(10_000);
    expect(result.dropped).toEqual([
      {
        trim: 'task-evidence',
        items: ['Checks Log', 'Deterministic Drift Report'],
      },
    ]);
    expect(result.prompt).not.toContain('v'.repeat(100));
    expect(result.prompt).toContain(EVIDENCE.validation);
    expect(result.prompt).toContain(EVIDENCE.sessionLog);
    expect(result.prompt).toContain(EVIDENCE.drift);
    expect(result.prompt).toContain('d'.repeat(2_000));
  });

  it('reports the size, the cap and the largest files when even the trimmed prompt is over', () => {
    const result = fitPrompt(
      input({
        files: [
          modified('src/declared-b.ts', 'e'.repeat(5_000)),
          modified('src/declared-a.ts', 'd'.repeat(15_000)),
        ],
      }),
      chars(10_000),
    );
    if (result.kind !== 'too-large') throw new Error(`expected too-large, got ${result.kind}`);
    expect(result.limit).toEqual(chars(10_000));
    expect(result.size).toBeGreaterThan(10_000);
    expect(result.largestFiles.map((file) => file.path)).toEqual([
      'src/declared-a.ts',
      'src/declared-b.ts',
    ]);
    expect(result.largestFiles[0]?.chars).toBeGreaterThan(result.largestFiles[1]?.chars ?? 0);
  });
  it('measures a byte limit in bytes, so a multibyte packet under the limit in characters is trimmed', () => {
    const prompt = input({
      files: [
        created('src/declared-new.ts', 'ż'.repeat(5_000)),
        modified('src/declared.ts', 'd'.repeat(500)),
      ],
    });
    const whole = PREFIX + buildFinalReviewPrompt(prompt);
    expect(whole.length).toBeLessThan(12_000);
    expect(Buffer.byteLength(whole, 'utf8')).toBeGreaterThan(12_000);

    const result = fitPrompt(prompt, { max: 12_000, unit: 'bytes' });

    if (result.kind !== 'fits') throw new Error(`expected a fit, got ${result.kind}`);
    expect(result.dropped).toEqual([{ trim: 'full-file-context', items: ['src/declared-new.ts'] }]);
    expect(result.size).toBe(Buffer.byteLength(result.prompt, 'utf8'));
    expect(result.size).toBeLessThanOrEqual(12_000);
    expect(result.prompt).toContain('d'.repeat(500));
  });

  it('reports a byte size and the byte limit when the trimmed packet stays over', () => {
    const prompt = input({ files: [modified('src/declared.ts', 'ż'.repeat(5_000))] });

    const result = fitPrompt(prompt, { max: 12_000, unit: 'bytes' });

    if (result.kind !== 'too-large') throw new Error(`expected too-large, got ${result.kind}`);
    expect(result.limit).toEqual({ max: 12_000, unit: 'bytes' });
    expect(result.size).toBe(Buffer.byteLength(PREFIX + buildFinalReviewPrompt(prompt), 'utf8'));
  });

  it('counts the text the call appends after the packet, such as the fallback schema', () => {
    const prompt = input({ files: [modified('src/declared.ts', 'd'.repeat(5_000))] });
    const whole = PREFIX + buildFinalReviewPrompt(prompt);
    const suffix = fallbackInstruction(REVIEW_ANSWER_JSON_SCHEMA);

    const over = fitPrompt(prompt, chars(whole.length), suffix);
    if (over.kind !== 'too-large') throw new Error(`expected too-large, got ${over.kind}`);
    expect(over.size).toBe(whole.length + suffix.length);

    const fits = fitPrompt(prompt, chars(whole.length + suffix.length), suffix);
    expect(fits).toMatchObject({ kind: 'fits', prompt: whole, size: whole.length + suffix.length });
  });
});
