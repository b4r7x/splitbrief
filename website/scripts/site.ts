import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEBSITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const OUTPUT_DIR = 'dist/client';
export const OUTPUT_PATH = resolve(WEBSITE_ROOT, OUTPUT_DIR);
export const PUBLIC_PATH = resolve(WEBSITE_ROOT, 'public');
export const SITE_URL = process.env.SITE_URL;

export function requireSiteUrl(siteUrl = SITE_URL): string {
  if (!siteUrl) {
    throw new Error(
      'SITE_URL is required for canonical metadata. Set it to the production HTTPS origin.',
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(siteUrl);
  } catch {
    throw new Error('SITE_URL must be an absolute HTTPS origin.');
  }

  const isOrigin =
    parsedUrl.protocol === 'https:' &&
    parsedUrl.username === '' &&
    parsedUrl.password === '' &&
    parsedUrl.pathname === '/' &&
    parsedUrl.search === '' &&
    parsedUrl.hash === '';
  if (!isOrigin) {
    throw new Error(
      'SITE_URL must be a production HTTPS origin without credentials, a path, query, or fragment.',
    );
  }

  return parsedUrl.origin;
}
