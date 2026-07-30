import { createFileRoute } from '@tanstack/react-router';
import { buildLLMsFullText } from '../lib/llms-text.js';
import { source } from '../lib/source.js';

export async function serveLLMsFullText(): Promise<Response> {
  return new Response(await buildLLMsFullText(source.getPages()), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

export const Route = createFileRoute('/llms-full.txt')({
  server: {
    handlers: {
      GET: serveLLMsFullText,
    },
  },
});
