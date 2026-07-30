import { describe, expect, it } from 'vitest';
import { DEFAULT_DESCRIPTION } from '../shared/site-identity.js';
import { pageMetadata, softwareApplicationJsonLd } from './seo-metadata.js';

describe('SEO metadata', () => {
  it('builds canonical and social URLs from the production origin', () => {
    const metadata = pageMetadata({
      description: DEFAULT_DESCRIPTION,
      path: '/docs/getting-started/introduction',
      siteOrigin: 'https://splitbrief.example',
      title: 'Introduction — SPLITBRIEF docs',
    });

    expect(metadata.links).toEqual([
      {
        rel: 'canonical',
        href: 'https://splitbrief.example/docs/getting-started/introduction',
      },
    ]);
    expect(metadata.meta).toContainEqual({
      property: 'og:image',
      content: 'https://splitbrief.example/og.png',
    });
    expect(metadata.meta).toContainEqual({
      name: 'twitter:card',
      content: 'summary_large_image',
    });
  });

  it('uses only source-backed SoftwareApplication values', () => {
    const jsonLd = softwareApplicationJsonLd({
      siteOrigin: 'https://splitbrief.example',
      version: '0.1.0',
    });

    expect(JSON.parse(jsonLd)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'SPLITBRIEF',
      softwareVersion: '0.1.0',
      license: 'https://opensource.org/license/mit',
      operatingSystem: 'macOS, Linux',
      applicationCategory: 'DeveloperApplication',
      downloadUrl: 'https://github.com/b4r7x/splitbrief',
      url: 'https://splitbrief.example/',
    });
    expect(jsonLd).not.toContain('</script');
  });
});
