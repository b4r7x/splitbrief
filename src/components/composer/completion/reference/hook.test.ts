import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, useState } from 'react';
import { Text } from 'ink';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createDraftDocument } from '../../../../core/composer/document.js';
import { prepareDraftSubmission } from '../../../../core/composer/submission.js';
import { useReferenceCompletion } from './hook.js';

const FILES = ['src/app.ts', 'src/index.ts'];

function ShowSuggestionsHarness({ value, suppressed }: { value: string; suppressed?: boolean }) {
  const reference = useReferenceCompletion({
    files: FILES,
    value,
    setValue: () => {},
    suppressed,
  });
  return createElement(Text, null, String(reference.showSuggestions));
}

function CompletionHarness({
  path,
  onComplete,
}: {
  path: string;
  onComplete?: (value: string) => void;
}) {
  const [value, setValue] = useState('read @');
  useReferenceCompletion({
    files: [path],
    value,
    setValue: (next) => {
      setValue(next);
      onComplete?.(next);
    },
  });
  return createElement(Text, null, value);
}

describe('reference completion paths', () => {
  let projectDir: string;
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    projectDir = createTempDir('reference-completion-');
    mkdirSync(join(projectDir, 'docs'));
  });

  afterEach(() => {
    unmount?.();
    unmount = undefined;
    cleanupTempDir(projectDir);
  });

  it.each([
    ['a b.md', 'read @"a b.md"'],
    ['docs/notes.md', 'read @docs/notes.md'],
  ])('inserts %s with the composer path grammar', async (path, expected) => {
    const ui = renderFeature(createElement(CompletionHarness, { path }));
    await flushEffects();
    ui.stdin.write('\t');
    await flushEffects();
    expect(ui.lastFrame()).toContain(expected);
    ui.unmount();
  });

  it.each([
    [String.raw`docs/a\b.md`, String.raw`read @docs/a\\b.md`],
    ['docs/my notes.md', 'read @"docs/my notes.md"'],
    ['docs/my "notes".md', 'read @\'docs/my "notes".md\''],
    ["docs/my 'notes'.md", 'read @"docs/my \'notes\'.md"'],
    [`docs/my "notes" 'v2'.md`, String.raw`read @docs/my\ \"notes\"\ \'v2\'.md`],
    [`'my "notes".md'`, String.raw`read @\'my\ \"notes\".md\'`],
  ])('submits completion for %s as the exact file and contents', async (path, expected) => {
    const content = `Contents of ${path}\nDo not resolve @./missing.md again.\n`;
    writeFileSync(join(projectDir, path), content);
    if (path.startsWith("'")) writeFileSync(join(projectDir, path.slice(1, -1)), 'Wrong file.');
    let completed = '';
    const ui = renderFeature(
      createElement(CompletionHarness, {
        path,
        onComplete: (value) => {
          completed = value;
        },
      }),
    );
    unmount = ui.unmount;
    await flushEffects();
    ui.stdin.write('\t');
    await flushEffects();

    expect(completed).toBe(expected);
    const submission = prepareDraftSubmission(createDraftDocument(completed), {
      projectDir,
      supportsImages: false,
    });
    expect(submission.ok).toBe(true);
    if (!submission.ok) throw new Error(`Submission failed: ${submission.reason}`);
    expect(submission.message.attachedInputs).toEqual([
      { kind: 'text', path: realpathSync(join(projectDir, path)) },
    ]);
    expect(submission.message.displayText).toBe(completed);
    expect(submission.plannerContext).toBe(
      `--- ${completed.slice('read '.length)} ---\n${content}`,
    );
    expect(submission.message.text).toBe(`${completed}\n\n${submission.plannerContext}`);
  });
});

describe('useReferenceCompletion suppression', () => {
  it('suppressed hides reference suggestions', async () => {
    const shown = renderFeature(createElement(ShowSuggestionsHarness, { value: '@src' }));
    await tick(20);
    expect(shown.lastFrame()).toContain('true');
    shown.unmount();

    const hidden = renderFeature(
      createElement(ShowSuggestionsHarness, { value: '@src', suppressed: true }),
    );
    await tick(20);
    expect(hidden.lastFrame()).toContain('false');
    hidden.unmount();
  });
});
