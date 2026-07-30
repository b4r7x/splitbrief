import { createFileRoute } from '@tanstack/react-router';
import type { LLMPage } from '../lib/get-llm-text.js';
import { buildLLMsIndex } from '../lib/llms-text.js';

export function llmsIndexResponse(pages: readonly LLMPage[], siteOrigin: string): Response {
  return new Response(buildLLMsIndex(pages, siteOrigin), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

export async function serveLLMsIndex(): Promise<Response> {
  const [{ source }, { productionSiteOrigin }] = await Promise.all([
    import('../lib/source.js'),
    import('../lib/site-origin.server.js'),
  ]);

  return llmsIndexResponse(source.getPages(), productionSiteOrigin());
}

export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: serveLLMsIndex,
    },
  },
});
