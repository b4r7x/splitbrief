import { describe, it, expect } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildLanguageContext } from './language-context.js';
import { buildEscalationPrompt, buildHintPrompt, parseHintVerdict } from './escalation.js';

describe('buildHintPrompt hand-back', () => {
  it('states the implementer hand-back after the validation error and asks for a verdict', () => {
    const prompt = buildHintPrompt(
      makeTask(),
      'tsc failed',
      undefined,
      'I could not find the prop.',
    );

    expect(prompt).toContain('## Implementer hand-back');
    expect(prompt).toContain('I could not find the prop.');
    expect(prompt.indexOf('## Implementer hand-back')).toBeGreaterThan(
      prompt.indexOf('## Validation Error'),
    );
    expect(prompt).toContain(
      'When the implementer stopped with a question, decide whether the brief or the implementer is at fault and answer it.',
    );
    expect(prompt).toContain('Begin your reply with exactly one line: `VERDICT: answer`');
  });

  it.each(['', '   '])('omits the section when the hand-back is %j', (handBack) => {
    const prompt = buildHintPrompt(makeTask(), 'tsc failed', undefined, handBack);
    expect(prompt).not.toContain('Implementer hand-back');
  });

  it('omits the section when no hand-back is given', () => {
    expect(buildHintPrompt(makeTask(), 'tsc failed')).not.toContain('Implementer hand-back');
  });

  it('keeps a nested fence inside the hand-back block', () => {
    const prompt = buildHintPrompt(makeTask(), 'tsc failed', undefined, '```\nnested fence\n```');
    const section = prompt.slice(prompt.indexOf('## Implementer hand-back'));
    expect(section).toContain('````\n```\nnested fence\n```\n````');
  });

  it('carries the brief scope and escalation bullets only when the task has them', () => {
    const bare = buildHintPrompt(makeTask(), 'tsc failed');
    expect(bare).not.toContain('## Scope');
    expect(bare).not.toContain('## Escalation');

    const scoped = buildHintPrompt(
      makeTask({
        scope: {
          inBounds: ['`src/hello.ts`'],
          outOfBounds: ['`src/consumer.ts`'],
          approvedOutOfBounds: ['`tsconfig.json`'],
        },
        escalation: ['Stop if the export has no consumer.'],
      }),
      'tsc failed',
    );
    expect(scoped).toContain('## Scope\n**In bounds:**\n- `src/hello.ts`');
    expect(scoped).toContain('**Out of bounds:**\n- `src/consumer.ts`');
    expect(scoped).toContain('**Approved out of bounds:**\n- `tsconfig.json`');
    expect(scoped).toContain('## Escalation\n- Stop if the export has no consumer.');
  });
});

describe('parseHintVerdict', () => {
  it('reads a widening with its paths and reason', () => {
    expect(
      parseHintVerdict(
        'VERDICT: widen `src/a.ts`, src/b.ts — b consumes the export\nRoot cause: the export moved.',
      ),
    ).toEqual({
      kind: 'widen',
      paths: ['src/a.ts', 'src/b.ts'],
      reason: 'b consumes the export',
    });
  });

  it('reads a brief verdict with its diagnosis', () => {
    expect(parseHintVerdict('VERDICT: brief — the export was already deleted')).toEqual({
      kind: 'brief',
      diagnosis: 'the export was already deleted',
    });
  });

  it('reads answer, and answers when no verdict line or no path is given', () => {
    expect(parseHintVerdict('VERDICT: answer\nAdd a default.')).toEqual({ kind: 'answer' });
    expect(parseHintVerdict('Root cause: missing import.')).toEqual({ kind: 'answer' });
    expect(parseHintVerdict('VERDICT: widen — no path named')).toEqual({ kind: 'answer' });
  });

  it('takes the first verdict line and ignores its case', () => {
    expect(parseHintVerdict('Note.\nverdict: Brief: wrong file\nVERDICT: answer')).toEqual({
      kind: 'brief',
      diagnosis: 'wrong file',
    });
  });

  it('reads widen without path on the line as answer', () => {
    expect(parseHintVerdict('VERDICT: widen\nRoot cause: the prop is optional')).toEqual({
      kind: 'answer',
    });
  });

  it('reads a backtick-wrapped brief verdict', () => {
    expect(parseHintVerdict('`VERDICT: brief — the export was already deleted`')).toEqual({
      kind: 'brief',
      diagnosis: 'the export was already deleted',
    });
  });

  it('reads bold verdict and normalizes paths with backticks and ./ prefix', () => {
    expect(
      parseHintVerdict('**VERDICT:** widen `src/a.ts`, ./src/b.ts. — consumer of the export'),
    ).toEqual({
      kind: 'widen',
      paths: ['src/a.ts', 'src/b.ts'],
      reason: 'consumer of the export',
    });
  });

  it('reads a widening naming a single file', () => {
    expect(parseHintVerdict('VERDICT: widen README.md — the README documents the flag')).toEqual({
      kind: 'widen',
      paths: ['README.md'],
      reason: 'the README documents the flag',
    });
  });

  it('reads a brief verdict preceded by commentary', () => {
    expect(parseHintVerdict('Here is my verdict.\nVERDICT: brief — x')).toEqual({
      kind: 'brief',
      diagnosis: 'x',
    });
  });

  it('reads answer verdict or commentary only as answer', () => {
    expect(parseHintVerdict('VERDICT: answer\nThe field is optional.')).toEqual({
      kind: 'answer',
    });
    expect(parseHintVerdict('Root cause only.')).toEqual({ kind: 'answer' });
  });

  it('preserves leading underscores in widened paths', () => {
    expect(parseHintVerdict('VERDICT: widen `__tests__/a.test.ts` — the suite')).toEqual({
      kind: 'widen',
      paths: ['__tests__/a.test.ts'],
      reason: 'the suite',
    });
  });
});

describe('escalation prompts', () => {
  it('TypeScript hint includes the ESM pitfall', () => {
    const prompt = buildHintPrompt(makeTask(), 'failed', buildLanguageContext('typescript'));
    expect(prompt).toContain('missing .js extension');
  });

  it('Python hint has no TypeScript or ESM-specific pitfall', () => {
    const prompt = buildHintPrompt(makeTask(), 'failed', buildLanguageContext('python'));
    expect(prompt).toContain('Python');
    expect(prompt).not.toMatch(/TypeScript|typescript|missing \.js extension|ESM imports/);
  });

  it('Python full escalation uses Python signature fences', () => {
    const task = makeTask({ signature: 'def load_config(path: str) -> dict[str, str]:' });
    const prompt = buildEscalationPrompt({
      task,
      lastAttempt: 'old code',
      error: 'failed',
      languageContext: buildLanguageContext('python'),
      isolationDir: '/work',
      outputMode: 'text',
    });
    expect(prompt).toContain('```python');
    expect(prompt).toContain('Python import statements');
    expect(prompt).not.toMatch(/TypeScript|typescript|```typescript|ESM imports/);
  });

  it('matches the full-escalation output contract to the planner write mode', () => {
    const task = makeTask();
    const common = { task, lastAttempt: 'old code', error: 'failed', isolationDir: '/work' };

    const filePrompt = buildEscalationPrompt({ ...common, outputMode: 'files' });
    expect(filePrompt).toContain(`Edit \`${task.file}\` directly in the current working directory`);
    expect(filePrompt).toContain('Make the changes on disk');
    expect(filePrompt).not.toContain('Respond with the complete file content');

    const textPrompt = buildEscalationPrompt({ ...common, outputMode: 'text' });
    expect(textPrompt).toContain(`Respond with the complete file content for \`${task.file}\``);
    expect(textPrompt).not.toContain('Make the changes on disk');
  });

  it('holds a files-mode escalation to the workspace rules of its own directory', () => {
    const common = {
      task: makeTask(),
      lastAttempt: 'old code',
      error: 'failed',
      isolationDir: '/work/trees/run-1',
    };

    const filePrompt = buildEscalationPrompt({ ...common, outputMode: 'files' });
    expect(filePrompt).toContain(
      '- Stay inside /work/trees/run-1: read, search, write and run shell commands only there',
    );
    expect(filePrompt).toContain('- Use git only to read (status, diff, log, show);');
    expect(filePrompt).toContain('- Dependencies are already installed;');

    const textPrompt = buildEscalationPrompt({ ...common, outputMode: 'text' });
    expect(textPrompt).not.toContain('Stay inside');
  });
});
