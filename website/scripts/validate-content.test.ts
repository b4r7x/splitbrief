// @vitest-environment node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOCS_PAGE_COUNT } from '../src/docs-page-count.js';
import {
  CONTENT_GROUPS,
  CONTENT_PAGE_CONTRACTS,
  CONTENT_PAGES,
  ROOT_META_PAGES,
} from './content-manifest.js';
import { validateContent } from './validate-content.js';

const fixtureDirectories: string[] = [];

function fixture(overrides: Readonly<Record<string, string>> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'splitbrief-content-'));
  fixtureDirectories.push(directory);
  for (const page of CONTENT_PAGE_CONTRACTS) {
    const file = join(directory, `${page.path}.mdx`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(
      file,
      overrides[page.path] ??
        [
          '---',
          `title: ${JSON.stringify(page.title)}`,
          'description: A precise description.',
          '---',
          '',
          '## Details',
          '',
        ].join('\n'),
    );
  }

  writeFileSync(
    join(directory, 'meta.json'),
    JSON.stringify({ title: 'Documentation', root: true, pages: ROOT_META_PAGES }),
  );
  for (const group of CONTENT_GROUPS) {
    writeFileSync(
      join(directory, group.path, 'meta.json'),
      JSON.stringify({ title: group.title, pages: group.pages }),
    );
  }

  return directory;
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('documentation content contract', () => {
  it('contains one unique canonical manifest with the binding import-mode counts', () => {
    expect(CONTENT_PAGES).toHaveLength(DOCS_PAGE_COUNT);
    expect(new Set(CONTENT_PAGES.map((page) => page.path)).size).toBe(DOCS_PAGE_COUNT);
    expect(CONTENT_PAGES.filter((page) => page.mode === 'as-is')).toHaveLength(14);
    expect(CONTENT_PAGES.filter((page) => page.mode === 'rewrite')).toHaveLength(15);
    expect(CONTENT_PAGES.filter((page) => page.mode === 'new')).toHaveLength(3);
  });

  it('validates the shipped content instead of only synthetic fixtures', () => {
    expect(validateContent()).toEqual([]);
  });

  it('accepts CRLF and treats nested shorter fences as code, not executable MDX', () => {
    const source = [
      '---',
      'title: Introduction',
      'description: A precise description.',
      '---',
      '',
      '## Details',
      '',
      '````md',
      '```md',
      'import Danger from "./danger.js"',
      '<Danger />',
      '```',
      '````',
      '',
    ].join('\r\n');
    expect(validateContent(fixture({ 'getting-started/introduction': source }))).toEqual([]);
  });

  it('reports missing files, malformed frontmatter, and incomplete metadata without throwing', () => {
    const directory = fixture({
      'getting-started/introduction': '---\ntitle: [\n---\n',
    });
    rmSync(join(directory, 'project', 'faq.mdx'));
    writeFileSync(join(directory, 'meta.json'), JSON.stringify({ pages: ROOT_META_PAGES }));
    writeFileSync(join(directory, 'guides', 'meta.json'), '{');

    expect(() => validateContent(directory)).not.toThrow();
    const messages = validateContent(directory).map((violation) => violation.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'manifest page is missing',
        expect.stringContaining('invalid YAML frontmatter'),
        'root metadata must contain the exact title, root flag, and manifest navigation',
        expect.stringContaining('cannot read valid JSON'),
      ]),
    );
  });

  it('rejects every executable MDX form, unsafe URLs, and likely live secrets', () => {
    const source = [
      '---',
      'title: Introduction',
      'description: A precise description.',
      '---',
      '',
      'export const value = 1',
      '',
      '{value}',
      '',
      '<Callout />',
      '',
      'Inline <span>HTML</span>.',
      '',
      '[Unsafe](javascript:payload)',
      '',
      'AKIAABCDEFGHIJKLMNOP',
      '',
    ].join('\n');
    const messages = validateContent(fixture({ 'getting-started/introduction': source })).map(
      (violation) => violation.message,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        'ESM import/export is not allowed in documentation MDX',
        'flow expression is not allowed in documentation MDX',
        'flow JSX is not allowed in documentation MDX',
        'inline JSX is not allowed in documentation MDX',
        'unsafe URL scheme "javascript:" is not allowed',
        expect.stringContaining('possible secret'),
      ]),
    );
  });

  it('rejects credential URLs and common provider token formats', () => {
    const source = [
      '---',
      'title: Introduction',
      'description: A precise description.',
      '---',
      '',
      '## Details',
      '',
      '[Userinfo](https://operator:private@example.com/reference)',
      '[Query credential](https://example.com/reference?api_key=live-value)',
      '[Hyphenated query](https://example.com/reference?client-secret=live-value)',
      '',
      'github_pat_11AAABBBCCCDDDEEEFFF000111222333444',
      'glpat-abcdefghijklmnopqrstuvwxyz123456',
      'xoxb-123456789012-abcdefghijklmnopqrstuv',
      'AIzaSyabcdefghijklmnopqrstuvwxyz1234567',
      'npm_abcdefghijklmnopqrstuvwxyz123456',
      'sk_live_abcdefghijklmnopqrstuvwxyz',
      '',
    ].join('\n');
    const messages = validateContent(fixture({ 'getting-started/introduction': source })).map(
      (violation) => violation.message,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        'credentials in URL userinfo are not allowed',
        'credential query parameter "api_key" is not allowed',
        'credential query parameter "client-secret" is not allowed',
        'possible secret matches GitHub fine-grained token',
        'possible secret matches GitLab token',
        'possible secret matches Slack token',
        'possible secret matches Google API key',
        'possible secret matches npm token',
        'possible secret matches Stripe live key',
      ]),
    );
  });

  it('allows explicit credential placeholders in prose and URLs', () => {
    const source = [
      '---',
      'title: Introduction',
      'description: A precise description.',
      '---',
      '',
      '## Details',
      '',
      '[Placeholder query](https://example.com/reference?api_key=YOUR_API_KEY)',
      '[Encoded placeholder](https://example.com/reference?client-secret=%3Cclient-secret%3E)',
      '',
      'github_pat_YOUR_TOKEN_HERE_REPLACE_ME',
      'glpat-YOUR_ACCESS_TOKEN_REPLACE_ME',
      'xoxb-YOUR-SLACK-TOKEN-REPLACE-ME',
      'AIzaYOUR_API_KEY_REPLACE_ME_0000000000000000000',
      'npm_YOUR_TOKEN_REPLACE_ME_0000000000',
      'sk_live_YOUR_SECRET_KEY_REPLACE_ME_0000000000',
      '',
    ].join('\n');

    expect(validateContent(fixture({ 'getting-started/introduction': source }))).toEqual([]);
  });

  it('detects setext H1s and requires an exact frontmatter schema', () => {
    const source = [
      '---',
      'title: Introduction',
      'description: A precise description.',
      'sidebar: hidden',
      '---',
      '',
      'Page title',
      '==========',
      '',
    ].join('\n');
    const violations = validateContent(fixture({ 'getting-started/introduction': source }));

    expect(violations.map((violation) => violation.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('frontmatter must contain exactly'),
        'body contains an H1; the docs shell owns the page H1',
      ]),
    );
  });

  it('requires the binding IA title for every page', () => {
    const source = [
      '---',
      'title: Intro',
      'description: A precise description.',
      '---',
      '',
      '## Details',
      '',
    ].join('\n');
    const violations = validateContent(fixture({ 'getting-started/introduction': source }));

    expect(violations.map((violation) => violation.message)).toContain(
      'frontmatter title must be "Introduction"',
    );

    const paddedTitle = source.replace('title: Intro', 'title: " Introduction "');
    expect(
      validateContent(fixture({ 'getting-started/introduction': paddedTitle })).map(
        (violation) => violation.message,
      ),
    ).toContain('frontmatter title must be "Introduction"');
  });
});
