import browserCollections from 'collections/browser';
import type { DocRouteData } from './doc-route.server.js';
import { DocsShell } from './layout.js';
import { mdxComponents } from './mdx-components.js';
import { createDocsToc } from './toc.js';

interface DocRendererProps {
  readonly data: DocRouteData;
}

const clientLoader = browserCollections.docs.createClientLoader<DocRendererProps>({
  component({ default: MDX, toc }, { data }) {
    return (
      <DocsShell
        currentPath={data.currentPath}
        groups={data.groups}
        title={data.title}
        toc={createDocsToc(toc)}
        {...(data.description === undefined ? {} : { description: data.description })}
        {...(data.previous ? { previous: data.previous } : {})}
        {...(data.next ? { next: data.next } : {})}
      >
        <MDX components={mdxComponents} />
      </DocsShell>
    );
  },
});

export function preloadDocContent(path: string) {
  return clientLoader.preload(path);
}

export function DocRenderer({ data }: DocRendererProps) {
  return clientLoader.useContent(data.path, { data });
}
