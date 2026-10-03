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

const DIRECT_WRITER_RULES = [
  'Start from the files the Task Brief suggests. If the change needs another project file (a caller, a test, a shared component), edit it and name it in your report with the reason. Never edit dependency manifests, lockfiles, CI configuration, env or key files, .git or .splitbrief unless the brief explicitly asks for that operation.',
  'The Task Brief inlines the read-only code of the context files it lists. Read the files it suggests before you edit them, and search only for a symbol the brief names.',
  "SPLITBRIEF runs the project's typecheck, lint, format and test gates after you finish, and its verdict is the authority. Do not run them, and do not run the whole test suite, screenshot or render tools, or repeated git diffs.",
  'Run at most the focused test files the brief lists under Tests, once, after your edits. If one fails and you cannot fix it, stop and report the failure.',
  "When the brief's Tests or Evidence ask you to run a project-wide gate or to render screenshots, SPLITBRIEF and the review seat do that. Implement the change and its tests, then report.",
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
      '{"status":"done","filesChanged":["<file>"],"touchedNotSuggested":[{"file":"<file>","reason":"<reason>"}],"notes":null}',
    );
    expect(prompt).toContain(
      '{"status":"blocked","question":"<question>","filesNeeded":["<file>"]}',
    );
    expect(prompt).not.toMatch(/completion report/i);
    expect(prompt).not.toContain('Files written:');
  });

  it('treats the suggested files as a start and names the protected paths', () => {
    const prompt = buildImplementerSystemPreamble(
      buildLanguageContext('typescript'),
      'direct',
      '/work',
    );
    for (const sentence of DIRECT_WRITER_RULES) {
      expect(prompt.split(sentence)).toHaveLength(2);
    }
    expect(prompt).toContain('"status":"done"');
    expect(prompt).not.toContain('Edit ONLY the files the Task Brief lists');
    expect(prompt).not.toContain('Every other file is out of bounds');
    expect(prompt).not.toContain('touching a file outside scope');
    expect(prompt).not.toContain('Run the validation commands the brief lists');
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
