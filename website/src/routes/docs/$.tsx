import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { DocRenderer } from '../../features/docs-ui/doc-client.js';
import type { DocRouteData } from '../../features/docs-ui/doc-route.server.js';
import { pageMetadata, SITE_ORIGIN } from '../../seo-metadata.js';
import { DEFAULT_DESCRIPTION } from '../../../shared/site-identity.js';

export function parseDocPath(input: unknown) {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('slugs' in input) ||
    !Array.isArray(input.slugs) ||
    input.slugs.length === 0 ||
    !input.slugs.every((slug: unknown) => typeof slug === 'string' && slug.length > 0)
  ) {
    throw new TypeError('Expected at least one non-empty documentation path segment');
  }

  return { slugs: input.slugs };
}

const loadDoc = createServerFn({ method: 'GET' })
  .validator(parseDocPath)
  .handler(async ({ data }) => {
    const { resolveDocRoute } = await import('../../features/docs-ui/doc-route.server.js');
    return resolveDocRoute(data);
  });

export function docsHead(loaderData: DocRouteData | undefined, siteOrigin = SITE_ORIGIN) {
  if (!loaderData) {
    return { links: [], meta: [] };
  }

  return pageMetadata({
    description: loaderData.description ?? DEFAULT_DESCRIPTION,
    path: loaderData.currentPath,
    siteOrigin,
    title: `${loaderData.title} — SPLITBRIEF docs`,
  });
}

export async function loadDocsRoute(splat: string | undefined): Promise<DocRouteData> {
  const data = await loadDoc({
    data: {
      slugs: splat?.split('/').filter(Boolean) ?? [],
    },
  });
  const { preloadDocContent } = await import('../../features/docs-ui/doc-client.js');
  await preloadDocContent(data.path);
  return data;
}

export const Route = createFileRoute('/docs/$')({
  loader: ({ params }) => loadDocsRoute(params._splat),
  head: ({ loaderData }) => docsHead(loaderData),
  component: DocPage,
  pendingMs: 150,
  staleTime: Number.POSITIVE_INFINITY,
});

function DocPage() {
  const data = Route.useLoaderData();
  return <DocRenderer data={data} />;
}
