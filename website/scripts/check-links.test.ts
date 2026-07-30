// @vitest-environment node

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkLinks, formatBrokenLink } from './check-links.js';

const fixtureDirectories: string[] = [];

function page(body: string): string {
  return ['---', 'title: Fixture', 'description: Fixture page.', '---', body, ''].join('\n');
}

function fixture(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(tmpdir(), 'splitbrief-links-'));
  fixtureDirectories.push(directory);

  for (const [path, source] of Object.entries(files)) {
    const file = join(directory, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, source);
  }

  return directory;
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('checkLinks', () => {
  it('parses references, multiline destinations, balanced parentheses, and duplicate fragments', () => {
    const directory = fixture({
      'guides/current.mdx': page(
        [
          '## Local',
          '[Absolute](/docs/reference/cli#start)',
          '[Relative](',
          '  ../reference/cli?value=(nested)#repeat-1',
          ')',
          '[Defined][cli]',
          '',
          '[cli]: ../reference/cli#start',
          '`[Inline code](/docs/missing)`',
          '````md',
          '```md',
          '[Example only](/docs/missing)',
          '```',
          '````',
          '[Fragment](#local)',
          '[External](https://example.com/docs)',
        ].join('\n'),
      ),
      'reference/cli.mdx': page(['## Start', '## Repeat', '## Repeat'].join('\n')),
    });
    const paths = new Set(['/docs/guides/current', '/docs/reference/cli']);

    expect(checkLinks({ contentDirectory: directory, knownPaths: paths })).toEqual([]);
  });

  it('reports missing routes, missing fragments, and raw Markdown links', () => {
    const directory = fixture({
      'guides/current.mdx': page(
        [
          '## Local',
          '[Missing](../reference/missing?view=full#top)',
          '[Missing fragment](../reference/cli#absent)',
          '[Raw mirror](/docs/reference/cli.md)',
        ].join('\n'),
      ),
      'reference/cli.mdx': page('## Start'),
    });
    const violations = checkLinks({
      contentDirectory: directory,
      knownPaths: new Set(['/docs/guides/current', '/docs/reference/cli']),
    });

    expect(violations).toHaveLength(3);
    const [firstViolation] = violations;
    if (!firstViolation) {
      throw new Error('Expected a missing-route violation');
    }
    expect(firstViolation).toMatchObject({
      href: '../reference/missing?view=full#top',
      kind: 'link',
      line: 6,
      message: 'internal route does not exist',
      resolvedPath: '/docs/reference/missing',
    });
    expect(violations.map((violation) => violation.message)).toEqual([
      'internal route does not exist',
      'documentation fragment does not exist',
      'public documentation links must use the canonical route, not a raw Markdown file',
    ]);
    expect(formatBrokenLink(firstViolation, directory)).toBe(
      'guides/current.mdx:6 ../reference/missing?view=full#top -> /docs/reference/missing: internal route does not exist',
    );
  });

  it('validates in-repository GitHub files, directories, headings, and line anchors', () => {
    const repositoryRoot = fixture({
      'content/current.mdx': page(
        [
          '[Heading](https://github.com/b4r7x/splitbrief/blob/main/docs/guide.md#repeat-1)',
          '[Line](https://github.com/b4r7x/splitbrief/blob/main/src/code.ts#L2)',
          '[Directory](https://github.com/b4r7x/splitbrief/tree/main/src)',
        ].join('\n'),
      ),
      'docs/guide.md': ['# Guide', '## Repeat', '## Repeat'].join('\n'),
      'src/code.ts': ['const first = 1;', 'const second = 2;'].join('\n'),
    });

    expect(
      checkLinks({
        contentDirectory: join(repositoryRoot, 'content'),
        knownPaths: new Set(['/docs/current']),
        repositoryRoot,
      }),
    ).toEqual([]);
  });

  it('reports invalid in-repository GitHub targets and malformed MDX as violations', () => {
    const repositoryRoot = fixture({
      'content/current.mdx': page(
        [
          '[Missing](https://github.com/b4r7x/splitbrief/blob/main/docs/missing.md)',
          '[Heading](https://github.com/b4r7x/splitbrief/blob/main/docs/guide.md#missing)',
          '[Line](https://github.com/b4r7x/splitbrief/blob/main/src/code.ts#L20)',
        ].join('\n'),
      ),
      'content/malformed.mdx': 'not frontmatter',
      'docs/guide.md': '# Guide',
      'src/code.ts': 'const only = 1;',
    });
    const violations = checkLinks({
      contentDirectory: join(repositoryRoot, 'content'),
      knownPaths: new Set(['/docs/current', '/docs/malformed']),
      repositoryRoot,
    });

    expect(violations.map((violation) => violation.message)).toEqual(
      expect.arrayContaining([
        'missing or malformed YAML frontmatter',
        'in-repository GitHub target does not exist',
        'GitHub Markdown fragment does not exist',
        'GitHub line fragment is outside the target file',
      ]),
    );
  });

  it('rejects malformed blob and tree links within the project repository', () => {
    const repositoryRoot = fixture({
      'content/current.mdx': page(
        [
          '[Wrong branch](https://github.com/b4r7x/splitbrief/blob/mainn/docs/guide.md)',
          '[Missing path](https://github.com/b4r7x/splitbrief/tree/main/)',
          '[Repository home](https://github.com/b4r7x/splitbrief/)',
          '[Repository issue](https://github.com/b4r7x/splitbrief/issues/1)',
        ].join('\n'),
      ),
    });

    const violations = checkLinks({
      contentDirectory: join(repositoryRoot, 'content'),
      knownPaths: new Set(['/docs/current']),
      repositoryRoot,
    });

    expect(violations.map((violation) => violation.message)).toEqual([
      'in-repository GitHub URL must use blob/main or tree/main with a target path',
      'in-repository GitHub URL must use blob/main or tree/main with a target path',
    ]);
  });

  it('fails closed when the content directory is missing, invalid, or empty', () => {
    const directory = fixture({
      'not-a-directory': 'file',
    });
    const missingDirectory = join(directory, 'missing');
    const invalidDirectory = join(directory, 'not-a-directory');
    const emptyDirectory = join(directory, 'empty');
    mkdirSync(emptyDirectory);

    expect(checkLinks({ contentDirectory: missingDirectory })[0]?.message).toContain(
      'cannot read directory',
    );
    expect(checkLinks({ contentDirectory: invalidDirectory })[0]?.message).toContain(
      'cannot read directory',
    );
    expect(checkLinks({ contentDirectory: emptyDirectory })).toContainEqual({
      file: emptyDirectory,
      kind: 'document',
      message: 'no documentation MDX files found',
    });
  });

  it('checks static metadata paths from the shared page universe', () => {
    const directory = fixture({
      'current.mdx': page('[LLMs](/llms-full.txt)'),
    });

    expect(
      checkLinks({
        contentDirectory: directory,
        knownPaths: new Set(['/docs/current', '/llms-full.txt']),
      }),
    ).toEqual([]);
  });

  it('checks the real shipped documentation graph', () => {
    expect(checkLinks()).toEqual([]);
  });
});
