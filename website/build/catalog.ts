import { readdir, readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lexer } from 'marked';

export const repository = fileURLToPath(new URL('../../', import.meta.url));
const github = 'https://github.com/b4r7x/splitbrief/blob/main/';

export type Guide = {
  source: string;
  route: string;
  title: string;
  description: string;
  markdown: string;
};
export type GuideGroup = { title: string; pages: Guide[] };

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(`${repository}${directory}`, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
    }),
  );
  return files.flat().sort();
}

function sourceFromLink(href: string, source: string) {
  const url = new URL(href, github + source);
  return url.href.startsWith(github)
    ? decodeURIComponent(url.pathname.slice(new URL(github).pathname.length))
    : undefined;
}

function routeFor(source: string) {
  if (source === 'README.md') return 'docs/project/';
  const path = source.replace(/^docs\//, '').replace(/(?:^|\/)README\.md$/, '');
  return `docs/${path.replace(/\.md$/, '').toLowerCase().replace(/\/$/, '')}${path ? '/' : ''}`;
}

export async function loadCatalog() {
  const sources = [
    ...(await markdownFiles('docs')),
    'README.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
  ];
  const pages = await Promise.all(
    sources.map(async (source): Promise<Guide> => {
      const markdown = await readFile(`${repository}${source}`, 'utf8');
      const tokens = Lexer.lex(markdown);
      const heading = tokens.find((token) => token.type === 'heading');
      const paragraph = tokens.find((token) => token.type === 'paragraph');
      const title = (heading && 'text' in heading ? heading.text : posix.basename(source, '.md'))
        .replace(/^SPLITBRIEF(?: Cookbook)?\s*[—:]\s*/, '')
        .replace(/ with SPLITBRIEF$/, '')
        .replace(/^SPLITBRIEF docs$/, 'Documentation')
        .replace(/[`*_]/g, '');
      const description = (
        paragraph && 'text' in paragraph ? paragraph.text : `${title}. SPLITBRIEF documentation.`
      )
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[`*_\n]/g, ' ')
        .slice(0, 180);
      return { source, route: routeFor(source), title, description, markdown };
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
  const remaining = pages.filter((page) => !assigned.has(page.source));
  const design = remaining.filter((page) => page.source.startsWith('docs/design/'));
  const more = remaining.filter((page) => !design.includes(page));
  if (more.length) groups.push({ title: 'More guides', pages: more });
  if (design.length) groups.push({ title: 'Design notes', pages: design });
  const practical = groups.findIndex((group) => group.title === 'Doing things');
  if (practical > 0) groups.unshift(...groups.splice(practical, 1));
  return { pages, groups: groups.filter((group) => group.pages.length > 0) };
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

export function sourceLink(page: Guide) {
  return github + page.source;
}
