import { describe, expect, it } from 'vitest';
import { describeGuide, guideLink, loadCatalog, readableLink } from './catalog.js';
import { renderGuide } from './markdown.js';

const userGuides = [
  'GETTING-STARTED',
  'MENTAL-MODEL',
  'WORKFLOW',
  'FEATURES',
  'CONCEPTS',
  'CLI-REFERENCE',
  'SLASH-COMMANDS-REFERENCE',
  'CONFIGURATION',
  'USAGE-EXAMPLES',
  'TROUBLESHOOTING',
  'API-KEYS',
  'HOOKS-CONFIG',
  'REPOMAP',
  'SKILLS',
  'DEBUGGING',
  'APPROVAL-AND-RECOVERY',
  'TASK-CONTRACT',
  'MIGRATION',
  'AUTH-METHOD-MATRIX',
];

describe('repository documentation', () => {
  it('publishes only the user guides, the index and the changelog, once each', async () => {
    const { pages, groups } = await loadCatalog();
    expect(pages.map((page) => page.source).sort()).toEqual(
      ['docs/README.md', 'CHANGELOG.md', ...userGuides.map((name) => `docs/${name}.md`)].sort(),
    );
    expect(new Set(pages.map((page) => page.route)).size).toBe(pages.length);
    expect(
      [
        'docs/README.md',
        ...groups.flatMap((group) => group.pages.map((page) => page.source)),
      ].sort(),
    ).toEqual(pages.map((page) => page.source).sort());
  });

  it('resolves all internal article links and section anchors, including nested guides', async () => {
    const catalog = await loadCatalog();
    const { pages } = catalog;
    const articles = pages.map((page) => ({ page, ...renderGuide(page, catalog) }));
    const ids = new Map(
      articles.map(({ page, article }) => [
        page.route,
        new Set([...article.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])),
      ]),
    );
    for (const { page, article } of articles) {
      expect((article.match(/<h1\b/g) ?? []).length, page.source).toBe(1);
      for (const match of article.matchAll(/href="([^"]+)"/g)) {
        const url = new URL(
          (match[1] ?? '').replaceAll('&amp;', '&'),
          `https://site.test/prefix/${page.route}`,
        );
        if (url.origin !== 'https://site.test') continue;
        const targets = ids.get(url.pathname.replace('/prefix/', ''));
        expect(targets, `${page.source} → ${url}`).toBeDefined();
        if (url.hash)
          expect(
            targets?.has(decodeURIComponent(url.hash.slice(1))),
            `${page.source} → ${url.hash}`,
          ).toBe(true);
      }
    }
  });

  it('keeps unsafe URLs and raw HTML out while retaining code and explicit anchors', async () => {
    const catalog = await loadCatalog();
    const { pages } = catalog;
    const original = pages.find((page) => page.source === 'docs/GETTING-STARTED.md');
    if (!original) throw new Error('Missing Getting started guide');
    const page = {
      ...original,
      markdown:
        '# Sample\n\n[bad](javascript:alert(1))\n\n<script>alert(1)</script>\n\n<a id="named-anchor"></a>\n\n```sh\nnpm install -g splitbrief\n```',
    };
    const { article } = renderGuide(page, catalog);
    expect(article).not.toContain('javascript:');
    expect(article).not.toContain('<script');
    expect(article).toContain('id="named-anchor"');
    expect(article).toContain('<code>npm install -g splitbrief</code>');
    expect(guideLink('./CLI-REFERENCE.md#start', page, pages)).toBe('../cli-reference/#start');
    expect(guideLink('../src/cli.ts', page, pages)).toBe(
      'https://github.com/b4r7x/splitbrief/blob/main/src/cli.ts',
    );
    expect(guideLink('./DOGFOODING.md#setup', page, pages)).toBe(
      'https://github.com/b4r7x/splitbrief/blob/main/docs/DOGFOODING.md#setup',
    );
  });

  it('describes every page in plain text short enough for a search result', async () => {
    const { pages } = await loadCatalog();
    for (const page of pages) {
      expect(page.description.length, page.source).toBeGreaterThan(20);
      expect(page.description.length, page.source).toBeLessThanOrEqual(161);
      expect(page.description, page.source).not.toMatch(/\*\*|`|\]\(|\s{2}/);
    }
    const configuration = pages.find((page) => page.source === 'docs/CONFIGURATION.md');
    expect(configuration?.description).toMatch(
      /^Complete reference for \.splitbrief\/config\.yaml/,
    );
  });

  it.each([
    {
      name: 'keeps wildcard paths and drops emphasis',
      source: 'docs/HOOKS.md',
      markdown:
        '# Hooks\n\nHooks run `src/**/*.ts` and `.splitbrief/hooks/*.yaml` checks before *each* brief.',
      title: 'Hooks',
      description: 'Hooks run src/**/*.ts and .splitbrief/hooks/*.yaml checks before each brief.',
    },
    {
      name: 'cuts at the last whole sentence within 160 characters',
      source: 'docs/A.md',
      markdown:
        '# A\n\nSPLITBRIEF plans the change in one typed session and writes plan.json. The implementer then types each brief inside an isolated run workspace. The reviewer reads the evidence, runs the reviewer checks and decides whether the run is ready to apply.',
      title: 'A',
      description:
        'SPLITBRIEF plans the change in one typed session and writes plan.json. The implementer then types each brief inside an isolated run workspace.',
    },
    {
      name: 'cuts one long sentence at a word boundary',
      source: 'docs/B.md',
      markdown:
        '# B\n\nThe planner reads the repository map, the open questions, the acceptance criteria, the protected paths, the validation commands, the task list, the evidence ledger and the context budget before it compiles anything at all',
      title: 'B',
      description:
        'The planner reads the repository map, the open questions, the acceptance criteria, the protected paths, the validation commands, the task list, the evidence…',
    },
    {
      name: 'takes an explicit description over the first paragraph',
      source: 'docs/CLI-REFERENCE.md',
      markdown: '# CLI Reference\n\nThis paragraph is a reading guide, not a summary.',
      title: 'CLI Reference',
      description:
        'Complete reference for every splitbrief command: start, spec, review, doctor, init, status, resume and continue.',
    },
    {
      name: 'falls back to the title without a paragraph',
      source: 'docs/C.md',
      markdown: '# SPLITBRIEF — How it works\n\n```sh\nnpm test\n```\n\n- a list item',
      title: 'How it works',
      description: 'How it works. SPLITBRIEF documentation.',
    },
    {
      name: 'reads the file name as words without a heading',
      source: 'docs/HOW-IT-WORKS.md',
      markdown: 'No heading here, only a sentence.',
      title: 'How it works',
      description: 'No heading here, only a sentence.',
    },
    {
      name: 'drops the product name before a capitalized title',
      source: 'docs/CONFIGURATION.md',
      markdown:
        '# SPLITBRIEF Configuration Reference\n\nComplete reference for `.splitbrief/config.yaml`.',
      title: 'Configuration Reference',
      description: 'Complete reference for .splitbrief/config.yaml.',
    },
    {
      name: 'keeps the product name before a lowercase phrase and drops link syntax',
      source: 'docs/SKILLS.md',
      markdown:
        '# SPLITBRIEF as agent skills\n\nSee [the skills](./SKILLS.md) for **four** pipeline skills.',
      title: 'SPLITBRIEF as agent skills',
      description: 'See the skills for four pipeline skills.',
    },
  ])('$name', ({ source, markdown, title, description }) => {
    expect(describeGuide(source, markdown)).toEqual({ title, description });
  });

  it('names linked Markdown files by title and keeps the onboarding order on the site', async () => {
    const catalog = await loadCatalog();
    const page = catalog.pages.find((page) => page.source === 'docs/GETTING-STARTED.md');
    const index = catalog.pages.find((page) => page.source === 'docs/README.md');
    if (!page || !index) throw new Error('Missing Getting started guide or index');
    const configuration = catalog.pages.find((page) => page.source === 'docs/CONFIGURATION.md');
    expect(configuration?.label).toBe('Configuration');
    expect(configuration?.title).toBe('Configuration Reference');
    const slashCommands = catalog.pages.find(
      (page) => page.source === 'docs/SLASH-COMMANDS-REFERENCE.md',
    );
    expect(slashCommands?.label).toBe('Slash commands');
    expect(slashCommands?.title).toBe('Slash Commands Reference');
    expect(readableLink('./WORKFLOW.md#apply', 'WORKFLOW.md §Apply', page, catalog.titles)).toBe(
      'Workflow §Apply',
    );
    expect(readableLink('./VISION.md', 'docs/VISION.md', page, catalog.titles)).toBe(
      'Vision & Strategic Direction',
    );
    expect(readableLink('./HOW-IT-WORKS.md', '`HOW-IT-WORKS.md`', page, catalog.titles)).toBe(
      'How it works',
    );
    expect(readableLink('./WORKFLOW.md', 'the workflow', page, catalog.titles)).toBeUndefined();
    const { article: indexArticle } = renderGuide(index, catalog);
    const onboarding = indexArticle.slice(
      indexArticle.indexOf('<blockquote>'),
      indexArticle.indexOf('</blockquote>'),
    );
    expect(
      [...onboarding.matchAll(/<li><a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]),
    ).toEqual([
      ['mental-model/', 'Mental model'],
      ['workflow/', 'Workflow'],
    ]);
    for (const { page, ...rendered } of catalog.pages.map((page) => ({
      page,
      ...renderGuide(page, catalog),
    })))
      expect(
        [...rendered.article.matchAll(/<a [^>]*>(?:<code>)?([^<]*)(?:<\/code>)?<\/a>/g)]
          .map((match) => match[1] ?? '')
          .filter((text) => /^(?:[\w.-]+\/)*[A-Z][A-Z0-9-]*\.md\b/.test(text)),
        page.source,
      ).toEqual([]);
  });
});
