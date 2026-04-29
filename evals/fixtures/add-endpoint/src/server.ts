import { routes } from './routes.js';

export type Response = {
  statusCode: number;
  body: unknown;
};

export function handleRequest(method: string, path: string): Response {
  const route = routes.find((candidate) => candidate.method === method && candidate.path === path);

  if (!route) {
    return {
      statusCode: 404,
      body: { error: 'Not found' },
    };
  }

  return {
    statusCode: 200,
    body: route.handler(),
  };
}

export function listRoutes(): string[] {
  return routes.map((route) => `${route.method} ${route.path}`);
}
