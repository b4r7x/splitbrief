import { createFileRoute } from '@tanstack/react-router';
import { createSearchAPI } from 'fumadocs-core/search/server';
import { createSimpleSearchIndexes } from '../../features/docs-ui/search-index.server.js';
import { source } from '../../lib/source.js';

const searchServer = createSearchAPI('simple', {
  indexes: () =>
    createSimpleSearchIndexes({
      pages: source.getPages(),
      tree: source.getPageTree(),
    }),
});

export function getStaticSearchIndex() {
  return searchServer.staticGET();
}

export const Route = createFileRoute('/api/search')({
  server: {
    handlers: {
      GET: getStaticSearchIndex,
    },
  },
});
