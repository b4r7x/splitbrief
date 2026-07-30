import {
  createRootRoute,
  HeadContent,
  Outlet,
  ScriptOnce,
  Scripts,
  useRouterState,
} from '@tanstack/react-router';
import { TanstackProvider } from 'fumadocs-core/framework/tanstack';
import { useEffect, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { DOCS_THEME_INIT_SCRIPT, synchronizeDocsTheme } from '../features/docs-ui/docs-theme.js';
import { DEFAULT_DESCRIPTION } from '../../shared/site-identity.js';
import appStyles from '../styles/index.css?url';

const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'SPLITBRIEF',
      },
      {
        name: 'description',
        content: DEFAULT_DESCRIPTION,
      },
    ],
    links: [
      {
        rel: 'icon',
        href: '/favicon.svg',
        type: 'image/svg+xml',
      },
      {
        rel: 'stylesheet',
        href: appStyles,
      },
      {
        rel: 'preload',
        href: '/fonts/archivo-latin-wdth-wght-d49f67a2df01.woff2',
        as: 'font',
        type: 'font/woff2',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'preload',
        href: '/fonts/fragment-mono-latin-400-7e8bf271dd15.woff2',
        as: 'font',
        type: 'font/woff2',
        crossOrigin: 'anonymous',
      },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
});

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html data-theme="dark" lang="en" suppressHydrationWarning>
      <head>
        <ScriptOnce>{DOCS_THEME_INIT_SCRIPT}</ScriptOnce>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  useClientLayoutEffect(() => {
    synchronizeDocsTheme(pathname);
  }, [pathname]);

  return (
    <TanstackProvider>
      <Outlet />
    </TanstackProvider>
  );
}
