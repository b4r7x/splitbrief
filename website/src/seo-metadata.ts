import { GITHUB_REPOSITORY_URL } from '../shared/site-identity.js';

export const SITE_ORIGIN = __SPLITBRIEF_SITE_ORIGIN__;

interface PageMetadataOptions {
  readonly description: string;
  readonly path: string;
  readonly siteOrigin: string;
  readonly title: string;
}

interface SoftwareApplicationOptions {
  readonly siteOrigin: string;
  readonly version: string;
}

export function absoluteSiteUrl(siteOrigin: string, path: string): string {
  return new URL(path, `${siteOrigin}/`).href;
}

export function pageMetadata({ description, path, siteOrigin, title }: PageMetadataOptions) {
  const baseMeta = [{ title }, { name: 'description', content: description }];
  if (siteOrigin === '') {
    return { links: [], meta: baseMeta };
  }

  const canonicalUrl = absoluteSiteUrl(siteOrigin, path);
  const imageUrl = absoluteSiteUrl(siteOrigin, '/og.png');

  return {
    links: [{ rel: 'canonical', href: canonicalUrl }],
    meta: [
      ...baseMeta,
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'SPLITBRIEF' },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: canonicalUrl },
      { property: 'og:image', content: imageUrl },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      {
        property: 'og:image:alt',
        content: 'SPLITBRIEF planner and implementer pin matrix',
      },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
      { name: 'twitter:image', content: imageUrl },
      {
        name: 'twitter:image:alt',
        content: 'SPLITBRIEF planner and implementer pin matrix',
      },
    ],
  };
}

export function softwareApplicationJsonLd({
  siteOrigin,
  version,
}: SoftwareApplicationOptions): string {
  const document = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'SPLITBRIEF',
    softwareVersion: version,
    license: 'https://opensource.org/license/mit',
    operatingSystem: 'macOS, Linux',
    applicationCategory: 'DeveloperApplication',
    downloadUrl: GITHUB_REPOSITORY_URL,
    url: absoluteSiteUrl(siteOrigin, '/'),
  };

  return JSON.stringify(document).replaceAll('<', '\\u003c');
}
