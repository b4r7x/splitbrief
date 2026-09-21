/**
 * A catalog seat observes its selected model on its own connection immediately
 * before every generation, so a fixture that answers only the completion leaves
 * that observation unanswered. These wrap a completion fixture with the
 * catalog the seat is about to read.
 */

function isCatalogRequest(input: unknown): boolean {
  const url = String(input);
  return url.includes('/api/tags') || url.includes('/api/ps') || url.endsWith('/models');
}

/** An Ollama inventory: `/api/tags` lists the models, `/api/ps` none loaded. */
export function localCatalogResponse(input: unknown, models: readonly string[]): Response {
  const body = String(input).includes('/api/ps')
    ? { models: [] }
    : { models: models.map((name) => ({ name })) };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A `fetch` implementation that serves the catalog and delegates the rest. */
export function withLocalCatalog(
  models: readonly string[],
  completion: (input: unknown, init?: unknown) => Response | Promise<Response>,
): (input: unknown, init?: unknown) => Promise<Response> {
  return async (input, init) =>
    isCatalogRequest(input) ? localCatalogResponse(input, models) : completion(input, init);
}
