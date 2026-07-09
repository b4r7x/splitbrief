import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const LINE_SUFFIX_PATTERN = /(?::\d+)+$/;
const OPAQUE_URL_SCHEMES: ReadonlySet<string> = new Set(['mailto']);
const ALLOWED_URL_SCHEMES: ReadonlySet<string> = new Set(['file', 'http', 'https', 'mailto']);

function splitLineSuffix(path: string): { base: string; suffix: string } {
  const match = LINE_SUFFIX_PATTERN.exec(path);
  if (!match) return { base: path, suffix: '' };
  return { base: path.slice(0, match.index), suffix: match[0] };
}

export function projectRelativePathLabel(input: { path: string; rootDir: string }): string {
  const { base, suffix } = splitLineSuffix(input.path);
  if (!isAbsolute(base)) return input.path;
  const relativePath = relative(input.rootDir, base);
  const insideRoot =
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
  return insideRoot ? relativePath + suffix : input.path;
}

export function filePathUrl(input: { path: string; rootDir: string }): string {
  return pathToFileURL(resolve(input.rootDir, splitLineSuffix(input.path).base)).href;
}

// Planner markdown is untrusted: path-shaped hrefs only ever emit file:// URLs (or no href at
// all), and URL-classified hrefs become clickable only when their scheme is allowlisted.
export function resolveMarkdownLinkTarget(input: {
  label: string;
  href: string | undefined;
  rootDir: string | undefined;
}): { label: string; href: string | undefined } {
  const { label, href, rootDir } = input;
  if (href === undefined) return { label, href };
  if (!isPathShapedHref(href)) {
    const scheme = hrefScheme(href);
    const allowed = scheme !== undefined && ALLOWED_URL_SCHEMES.has(scheme);
    return { label, href: allowed ? href : undefined };
  }
  if (rootDir === undefined) return { label, href: undefined };
  return {
    label: projectRelativePathLabel({ path: label, rootDir }),
    href: filePathUrl({ path: href, rootDir }),
  };
}

// A scheme-looking prefix counts as a URL only when '//' follows the colon or the scheme is an
// allowlisted opaque one; slashless file.ext:line references stay path-shaped.
function isPathShapedHref(href: string): boolean {
  const scheme = hrefScheme(href);
  if (scheme === undefined) return true;
  return !href.startsWith('//', scheme.length + 1) && !OPAQUE_URL_SCHEMES.has(scheme);
}

function hrefScheme(href: string): string | undefined {
  const match = /^[a-z][a-z0-9+.-]*:/i.exec(href);
  return match === null ? undefined : match[0].slice(0, -1).toLowerCase();
}
