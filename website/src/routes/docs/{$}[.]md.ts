import { createFileRoute } from '@tanstack/react-router';
import { getLLMText } from '../../lib/get-llm-text.js';
import { source } from '../../lib/source.js';

export async function serveMarkdownMirror({
  params,
}: {
  params: { _splat?: string };
}): Promise<Response> {
  const slugPath = (params._splat ?? '').replace(/\.md$/, '');
  const page = source.getPage(slugPath.split('/').filter(Boolean));

  if (!page) {
    return new Response('Document not found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  return new Response(await getLLMText(page), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  });
}

export const Route = createFileRoute('/docs/{$}.md')({
  server: {
    handlers: {
      GET: serveMarkdownMirror,
    },
  },
});
