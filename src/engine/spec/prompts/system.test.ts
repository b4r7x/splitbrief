import { defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { formatTaskPrompt } from '../prompt-formatter.js';
import { describe, it, expect } from 'vitest';
import { buildLanguageContext } from './language-context.js';
import { buildImplementerSystemPreamble, buildSystemPreamble } from './system.js';

describe('buildSystemPreamble', () => {
  it('TypeScript preamble keeps TypeScript conventions', () => {
    const prompt = buildSystemPreamble(buildLanguageContext('typescript'));
    expect(prompt).toContain('TypeScript code generator');
    expect(prompt).toContain('ESM imports with .js extensions');
    expect(prompt).toContain('import type { Config } from');
    expect(prompt).toContain('dir: string');
  });

  it('Python preamble has no TypeScript references', () => {
    const prompt = buildSystemPreamble(buildLanguageContext('python'));
    expect(prompt).toContain('Python code generator');
    expect(prompt).toContain('Python import statements');
    expect(prompt).toContain('def load_config(directory: str)');
    expect(prompt).not.toMatch(/TypeScript|typescript|import type|\.js extensions|dir: string/);
  });

  it('generic preamble avoids language-specific examples', () => {
    const prompt = buildSystemPreamble();
    expect(prompt).toContain('project language');
    expect(prompt).not.toMatch(/TypeScript|typescript|PEP 484|\.js extensions/);
  });
});

const GATE_RULE =
  'SPLITBRIEF runs the checks after you hand back, and its verdict is the authority. Run no test, typecheck, lint, format, screenshot, render or other check command, not even the tests you write or a command the brief names.';

const DIRECT_WRITER_RULES = [
  'Start from the files the Task Brief suggests. If the change needs another project file (a caller, a test, a shared component), edit it and name it in your report with the reason. Never edit dependency manifests, lockfiles, CI configuration, env or key files, .git or .splitbrief unless the brief explicitly asks for that operation.',
  'The Task Brief inlines the read-only code of the context files it lists. Read the files it suggests before you edit them, and search only for a symbol the brief names.',
  GATE_RULE,
  'Guidance only: another approach that passes the checks is fine.',
  'Report deviations as decisions with what and why; use [] when none.',
];

describe('buildImplementerSystemPreamble', () => {
  it('gives the direct writer a full prompt contract', () => {
    const languageContext = buildLanguageContext('python');
    const prompt = buildImplementerSystemPreamble(languageContext, 'direct', '/work');

    expect(prompt).toContain('SYSTEM:');
    expect(prompt).toContain('Python');
    expect(prompt).toContain('Python import statements (from/import)');
    expect(prompt).toMatch(/stop and report/i);
    expect(prompt).toMatch(/ONE JSON object/);
  });

  it('ends the direct writer with one ImplementerReport JSON object', () => {
    const prompt = buildImplementerSystemPreamble(
      buildLanguageContext('typescript'),
      'direct',
      '/work',
    );

    expect(prompt).toContain(
      '{"status":"done","filesChanged":["<file>"],"touchedNotSuggested":[{"file":"<file>","reason":"<reason>"}],"notes":null,"decisions":[{"what":"<decision>","why":"<reason>"}]}',
    );
    expect(prompt).toContain(
      '{"status":"blocked","question":"<question>","filesNeeded":["<file>"]}',
    );
    expect(prompt).not.toMatch(/completion report/i);
    expect(prompt).not.toContain('Files written:');
  });

  it('treats the suggested files as a start and names the protected paths', () => {
    const prompt =
      buildImplementerSystemPreamble(buildLanguageContext('typescript'), 'direct', '/work') +
      formatTaskPrompt({
        task: makeTask({ implementationSteps: ['Build the greeting'] }),
        context: defaultContext,
      });
    for (const sentence of DIRECT_WRITER_RULES) {
      expect(prompt.split(sentence)).toHaveLength(2);
    }
    expect(prompt).toContain('"status":"done"');
    expect(prompt).not.toContain('Edit ONLY the files the Task Brief lists');
    expect(prompt).not.toContain('Every other file is out of bounds');
    expect(prompt).not.toContain('touching a file outside scope');
    expect(prompt).not.toContain('Run the validation commands the brief lists');
  });

  it('forbids every check command once across the assembled direct-writer prompt', () => {
    const prompt = [
      buildImplementerSystemPreamble(buildLanguageContext('typescript'), 'direct', '/work'),
      formatTaskPrompt({
        task: makeTask({
          suggestedFiles: ['src/greet.ts', 'src/greet.test.ts'],
          tests: ['src/greet.test.ts: greet("Ada") returns "Hello, Ada"'],
          evidence: ['src/greet.test.ts passes'],
        }),
        context: defaultContext,
        writesFiles: 'direct',
      }),
    ].join('\n\n');

    expect(prompt.split(GATE_RULE)).toHaveLength(2);
    const runTestSentences = prompt
      .split(/(?<=\.)\s+|\n/)
      .filter((sentence) => /\brun\b/i.test(sentence) && /\btests?\b/i.test(sentence));
    expect(runTestSentences).toEqual([
      'Run no test, typecheck, lint, format, screenshot, render or other check command, not even the tests you write or a command the brief names.',
      'SPLITBRIEF runs the checks after you hand back, so run no test, typecheck, lint or other check command.',
    ]);
  });

  it('offers the blocked form in the file-bundle preamble', () => {
    const prompt = buildImplementerSystemPreamble(
      buildLanguageContext('typescript'),
      'extracted-code',
      '/work',
      'file-bundle-v1',
    );
    expect(prompt).toContain('{"version":1,"blocked":{"question":"...","filesNeeded":["..."]}}');
  });

  it('leaves the file-bundle preamble without the direct-writer rules', () => {
    const prompt = buildImplementerSystemPreamble(
      buildLanguageContext('typescript'),
      'extracted-code',
      '/work',
      'file-bundle-v1',
    );
    expect(prompt).toContain('Answer with ONE JSON object and nothing else');
    for (const sentence of DIRECT_WRITER_RULES) expect(prompt).not.toContain(sentence);
  });

  it('leaves the extracted-code preamble without the direct-writer rules', () => {
    const prompt = buildImplementerSystemPreamble(
      buildLanguageContext('typescript'),
      'extracted-code',
      '/work',
    );
    for (const sentence of DIRECT_WRITER_RULES) expect(prompt).not.toContain(sentence);
  });

  it('names the isolation directory and forbids git writes and package installs', () => {
    const prompt = buildImplementerSystemPreamble(
      buildLanguageContext('typescript'),
      'direct',
      '/work/trees/run-1',
    );
    expect(prompt).toContain(
      '- Stay inside /work/trees/run-1: read, search, write and run shell commands only there, and never look for other copies of the project',
    );
    expect(prompt).toContain(
      '- Use git only to read (status, diff, log, show); never commit, branch, tag, checkout, switch, stash, reset, restore, rebase, merge, add, or change git config or hooks',
    );
    expect(prompt).toContain(
      '- Dependencies are already installed; never run a package-manager install, ci, add, remove or update (npm, pnpm, yarn, bun)',
    );
  });

  it('tells an in-place writer its edits land in the checkout, not in an isolation directory', () => {
    const inPlace = buildImplementerSystemPreamble(
      buildLanguageContext('typescript'),
      'direct',
      '/work/project',
      undefined,
      true,
    );
    expect(inPlace).toContain("directly in the user's checkout");
    expect(inPlace).not.toContain('isolation directory');
    expect(inPlace).not.toContain('promoted');
    expect(inPlace).toContain('- Stay inside /work/project:');
    const isolated = buildImplementerSystemPreamble(
      buildLanguageContext('typescript'),
      'direct',
      '/work/project',
    );
    expect(isolated).toContain('directly in the isolation directory');
  });

  it('no longer describes the direct workspace as staged', () => {
    const prompt = buildImplementerSystemPreamble(
      buildLanguageContext('typescript'),
      'direct',
      '/work',
    );
    expect(prompt).not.toMatch(/staged/i);
  });

  it('reuses the complete-file preamble for extracted-code implementers', () => {
    const languageContext = buildLanguageContext('typescript');

    expect(buildImplementerSystemPreamble(languageContext, 'extracted-code', '/work')).toBe(
      buildSystemPreamble(languageContext),
    );
  });
});
