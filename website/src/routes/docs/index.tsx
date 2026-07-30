import { createFileRoute, redirect } from '@tanstack/react-router';
import { DOCS_HOME_PATH } from '../../docs-home-path.js';

export function redirectToDocsHome() {
  return redirect({
    href: DOCS_HOME_PATH,
    replace: true,
    statusCode: 301,
    throw: true,
  });
}

export const Route = createFileRoute('/docs/')({ loader: redirectToDocsHome });
