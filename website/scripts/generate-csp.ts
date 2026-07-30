import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_PATH, WEBSITE_ROOT } from './site.js';

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const CSP_INCLUDE_PATH = resolve(WEBSITE_ROOT, 'dist/nginx-csp.conf');

interface GenerateCspOptions {
  readonly includePath?: string;
  readonly outputDirectory?: string;
}

async function htmlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return htmlFiles(path);
      }
      return entry.isFile() && entry.name.endsWith('.html') ? [path] : [];
    }),
  );

  return nestedFiles.flat().sort((left, right) => left.localeCompare(right));
}

function inlineScriptSources(html: string): string[] {
  const sources: string[] = [];

  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const attributes = match[1] ?? '';
    const source = match[2] ?? '';
    if (/\bsrc\s*=/i.test(attributes) || source.trim().length === 0) {
      continue;
    }
    sources.push(source);
  }

  return sources;
}

export function scriptHash(source: string): string {
  const browserSource = source.replace(/\r\n?/g, '\n').replaceAll('\0', '\uFFFD');
  const digest = createHash('sha256').update(browserSource).digest('base64');
  return `'sha256-${digest}'`;
}

export function cspPolicy(scriptHashes: readonly string[]): string {
  const scriptSources = ["'self'", ...[...new Set(scriptHashes)].sort()].join(' ');

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `script-src ${scriptSources}`,
    "script-src-attr 'none'",
  ].join('; ');
}

export async function generateCsp({
  includePath = CSP_INCLUDE_PATH,
  outputDirectory = OUTPUT_PATH,
}: GenerateCspOptions = {}): Promise<readonly string[]> {
  const paths = await htmlFiles(outputDirectory);
  if (paths.length === 0) {
    throw new Error(`No built HTML files found in ${outputDirectory}`);
  }

  const sources = (
    await Promise.all(paths.map(async (path) => inlineScriptSources(await readFile(path, 'utf8'))))
  ).flat();
  const hashes = [...new Set(sources.map(scriptHash))].sort();
  if (hashes.length === 0) {
    throw new Error(`No inline scripts found in built HTML under ${outputDirectory}`);
  }

  const policy = cspPolicy(hashes);
  await mkdir(dirname(includePath), { recursive: true });
  await writeFile(includePath, `add_header Content-Security-Policy "${policy}" always;\n`);

  return hashes;
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  const hashes = await generateCsp();
  process.stdout.write(`CSP: ${hashes.length} inline script hashes\n`);
}
