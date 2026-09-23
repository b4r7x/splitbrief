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

describe('buildImplementerSystemPreamble', () => {
  it('gives the direct writer a full prompt contract', () => {
    const languageContext = buildLanguageContext('python');
    const prompt = buildImplementerSystemPreamble(languageContext, 'direct', '/work');

    expect(prompt).toContain('SYSTEM:');
    expect(prompt).toContain('Python');
    expect(prompt).toContain('Python import statements (from/import)');
    expect(prompt).toMatch(/edit only the file/i);
    expect(prompt).toMatch(/out of bounds/i);
    expect(prompt).toMatch(/stop and report/i);
    expect(prompt).toMatch(/validation commands/i);
    expect(prompt).toMatch(/completion report/i);
  });

  it('licenses the brief-declared files plus the Scope bullets, nothing else', () => {
    const prompt = buildImplementerSystemPreamble(
      buildLanguageContext('typescript'),
      'direct',
      '/work',
    );
    expect(prompt).toContain(
      'Edit ONLY the files the Task Brief lists under Files, plus every path its Scope names under In bounds or Approved out of bounds',
    );
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
