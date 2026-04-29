export type HttpMethod = 'GET' | 'POST';

export type Route = {
  method: HttpMethod;
  path: string;
  handler: () => unknown;
};

export const routes: Route[] = [
  {
    method: 'GET',
    path: '/api/version',
    handler: () => ({ version: '1.0.0' }),
  },
];
