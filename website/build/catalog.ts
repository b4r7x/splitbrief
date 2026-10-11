import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lexer, type Token, type Tokens } from 'marked';
import { site } from './site.js';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
const github = `${site.repository}/blob/main/`;

// The user guides the npm package ships. Maintainer pages stay on GitHub.
const published = [
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
export const sources = [
  'docs/README.md',
  ...published.map((name) => `docs/${name}.md`),
  'CHANGELOG.md',
];

// Pages whose opening paragraph is a reading guide or maintainer note, not a summary.
const descriptions: Record<string, string> = {
  'docs/README.md':
    'Guides and references for SPLITBRIEF: install it, configure the planner and implementer, and follow a run.',
  'docs/CLI-REFERENCE.md':
    'Complete reference for every splitbrief command: start, spec, review, doctor, init, status, resume and continue.',
  'docs/TASK-CONTRACT.md':
    'The Task Brief contract: the plan.json shape, the brief schema, plan checks, evidence and the state.json v4 boundary.',
  'CHANGELOG.md': 'Release notes for SPLITBRIEF: what changed in each version.',
};

// Library labels for pages whose title wraps in the narrow menu.
const labels: Record<string, string> = {
  'docs/CONFIGURATION.md': 'Configuration',
  'docs/SLASH-COMMANDS-REFERENCE.md': 'Slash commands',
};

export type Guide = {
  source: string;
  route: string;
  title: string;
  label: string;
  description: string;
  markdown: string;
};
type GuideGroup = { title: string; pages: Guide[] };

function plainText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === 'html' || token.type === 'image') return '';
      if (token.type !== 'codespan' && 'tokens' in token && token.tokens)
        return plainText(token.tokens);
      return 'text' in token ? token.text : ' ';
    })
    .join('');
}

// Whole sentences up to the snippet length search engines show, else a word boundary.
function summarize(text: string, limit = 160) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  let summary = '';
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    const next = summary ? `${summary} ${sentence}` : sentence;
    if (next.length > limit) break;
    summary = next;
  }
  if (summary) return summary;
  const cut = clean.slice(0, limit);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:—–-]+$/, '')}…`;
}

function sourceFromLink(href: string, source: string) {
  const url = new URL(href, github + source);
  return url.href.startsWith(github)
    ? decodeURIComponent(url.pathname.slice(new URL(github).pathname.length))
    : undefined;
}

function routeFor(source: string) {
  return source === 'docs/README.md'
    ? 'docs/'
    : `docs/${posix.basename(source, '.md').toLowerCase()}/`;
}

const guideTitle = (heading: string) =>
  heading
    .replace(/^SPLITBRIEF(?: Cookbook)?\s*[—:]\s*/, '')
    .replace(/ with SPLITBRIEF$/, '')
    .replace(/^SPLITBRIEF docs$/, 'Documentation')
    .replace(/^SPLITBRIEF (?=[A-Z])/, '')
    .replace(/[`*_]/g, '');

function headingTitle(tokens: readonly Token[]) {
  const heading = tokens.find((token) => token.type === 'heading');
  return heading && 'text' in heading ? guideTitle(heading.text) : undefined;
}

// A file without a readable heading still reads as words: HOW-IT-WORKS.md → How it works.
function fileTitle(source: string) {
  const name = posix.basename(source, '.md');
  if (!/[-_]/.test(name)) return name.charAt(0).toUpperCase() + name.slice(1);
  const words = name.replace(/[-_]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Title and search-result description of one Markdown source. */
export function describeGuide(source: string, markdown: string) {
  const tokens = Lexer.lex(markdown);
  const paragraph = tokens.find((token): token is Tokens.Paragraph => token.type === 'paragraph');
  const title = headingTitle(tokens) ?? fileTitle(source);
  const description =
    descriptions[source] ??
    (paragraph ? summarize(plainText(paragraph.tokens)) : `${title}. SPLITBRIEF documentation.`);
  return { title, description };
}

// Titles for every Markdown file a published page links to. Unpublished guides take the
// heading of their source under docs/, which the production image also copies; any other
// file takes its file name, so a local build and the image build read the same titles.
async function linkTitles(pages: readonly Guide[]) {
  const titles = new Map(pages.map((page) => [page.source, page.title]));
  const linked = new Set<string>();
  for (const page of pages)
    for (const match of page.markdown.matchAll(/\]\(<?([^)\s>]+)/g)) {
      const source = sourceFromLink(match[1] ?? '', page.source);
      if (source?.endsWith('.md') && !titles.has(source)) linked.add(source);
    }
  await Promise.all(
    [...linked].map(async (source) => {
      const markdown = source.startsWith('docs/')
        ? await readFile(`${repository}${source}`, 'utf8').catch(() => '')
        : '';
      titles.set(source, headingTitle(Lexer.lex(markdown)) ?? fileTitle(source));
    }),
  );
  return titles;
}

export async function loadCatalog() {
  const pages = await Promise.all(
    sources.map(async (source): Promise<Guide> => {
      const markdown = await readFile(`${repository}${source}`, 'utf8');
      const { title, description } = describeGuide(source, markdown);
      const label = labels[source] ?? title;
      return { source, route: routeFor(source), title, label, description, markdown };
    }),
  );
  const groups: GuideGroup[] = [];
  const assigned = new Set(['docs/README.md']);
  const index = pages.find((page) => page.source === 'docs/README.md');
  let group: GuideGroup | undefined;
  for (const line of index?.markdown.split('\n') ?? []) {
    if (line.startsWith('## ')) {
      group = { title: line.slice(3), pages: [] };
      groups.push(group);
    }
    if (!group) continue;
    for (const match of line.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const source = sourceFromLink(match[1] ?? '', 'docs/README.md');
      const page = pages.find((page) => page.source === source);
      if (!page || assigned.has(page.source)) continue;
      group.pages.push(page);
      assigned.add(page.source);
    }
  }
  const more = pages.filter((page) => !assigned.has(page.source));
  if (more.length) groups.push({ title: 'More guides', pages: more });
  const practical = groups.findIndex((group) => group.title === 'Doing things');
  if (practical > 0) groups.unshift(...groups.splice(practical, 1));
  return {
    pages,
    groups: groups.filter((group) => group.pages.length > 0),
    titles: await linkTitles(pages),
  };
}

export function guideLink(href: string, page: Guide, pages: readonly Guide[]) {
  if (href.startsWith('#')) return href;
  const url = new URL(href, github + page.source);
  if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return undefined;
  const source = sourceFromLink(href, page.source);
  const target = pages.find((candidate) => candidate.source === source);
  if (!target) return url.href;
  const relative = posix.relative(page.route, target.route);
  return `${relative ? `${relative}/` : './'}${url.search}${url.hash}`;
}

// Link text that only names a Markdown file reads as that file's title; a § section stays.
export function readableLink(
  href: string,
  text: string,
  page: Guide,
  titles: ReadonlyMap<string, string>,
) {
  const source = sourceFromLink(href, page.source);
  const title = source && titles.get(source);
  const name = text.trim().match(/^`?(?:[\w.-]+\/)*([\w.-]+\.md)(?:#\S*)?`?(?:\s*§\s*(.+))?$/);
  if (!source || !title || !name || name[1] !== posix.basename(source)) return undefined;
  return name[2] ? `${title} §${name[2].replace(/[`*_]/g, '')}` : title;
}

/** Whether a link names a repository Markdown file the site does not publish. */
export function unpublishedLink(href: string, page: Guide, pages: readonly Guide[]) {
  const source = sourceFromLink(href, page.source);
  return source?.endsWith('.md') === true && !pages.some((target) => target.source === source);
}

export function sourceLink(page: Guide) {
  return github + page.source;
}
