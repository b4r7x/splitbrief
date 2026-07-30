import { realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_HOME_PATH } from '../src/docs-home-path.js';
import { serveStaticOptions } from './serve-static-options.js';
import { OUTPUT_DIR } from './site.js';
import { findExistingStaticFile, findStaticFile } from './static-file.js';
import { sendStaticFile, sendText, staticContentType } from './static-response.js';

function decodeRequestPath(requestUrl: string | undefined): string | undefined {
  const target = requestUrl ?? '/';
  const separatorIndex = target.search(/[?#]/);
  const encodedPath = separatorIndex === -1 ? target : target.slice(0, separatorIndex);
  if (!encodedPath.startsWith('/')) {
    return undefined;
  }

  try {
    const pathname = decodeURIComponent(encodedPath);
    const hasTraversal = pathname.split('/').some((segment) => segment === '..');
    if (pathname.includes('\0') || pathname.includes('\\') || hasTraversal) {
      return undefined;
    }

    return pathname;
  } catch {
    return undefined;
  }
}

async function sendNotFound(options: {
  readonly headOnly: boolean;
  readonly response: ServerResponse;
  readonly rootDirectory: string;
}): Promise<void> {
  const notFoundPath = await findExistingStaticFile({
    candidatePath: resolve(options.rootDirectory, '404.html'),
    rootDirectory: options.rootDirectory,
  });

  if (notFoundPath) {
    await sendStaticFile({
      file: notFoundPath,
      headOnly: options.headOnly,
      response: options.response,
      status: 404,
      type: 'text/html; charset=utf-8',
    });
    return;
  }

  sendText({
    headOnly: options.headOnly,
    response: options.response,
    status: 404,
    text: 'Not Found\n',
  });
}

async function handleRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly rootDirectory: string;
}): Promise<void> {
  const method = options.request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    options.response.setHeader('Allow', 'GET, HEAD');
    sendText({
      headOnly: false,
      response: options.response,
      status: 405,
      text: 'Method Not Allowed\n',
    });
    return;
  }

  const pathname = decodeRequestPath(options.request.url);
  if (!pathname) {
    sendText({
      headOnly: method === 'HEAD',
      response: options.response,
      status: 400,
      text: 'Bad Request\n',
    });
    return;
  }

  if (pathname === '/docs') {
    options.response.writeHead(301, {
      'Content-Length': 0,
      Location: DOCS_HOME_PATH,
    });
    options.response.end();
    return;
  }

  const filePath = await findStaticFile({
    pathname,
    rootDirectory: options.rootDirectory,
  });
  if (!filePath) {
    await sendNotFound({
      headOnly: method === 'HEAD',
      response: options.response,
      rootDirectory: options.rootDirectory,
    });
    return;
  }

  await sendStaticFile({
    file: filePath,
    headOnly: method === 'HEAD',
    response: options.response,
    status: 200,
    type: staticContentType({ filePath: filePath.path, requestPath: pathname }),
  });
}

type CreateStaticServerOptions = {
  readonly onError?: (error: unknown) => void;
  readonly rootDirectory?: string;
};

function logRequestError(error: unknown): void {
  console.error('[serve-static] Request failed:', error);
}

export function createStaticServer({
  onError = logRequestError,
  rootDirectory = resolve(process.cwd(), OUTPUT_DIR),
}: CreateStaticServerOptions = {}): ReturnType<typeof createServer> {
  const resolvedRoot = realpathSync(resolve(rootDirectory));

  return createServer((request, response) => {
    handleRequest({ request, response, rootDirectory: resolvedRoot }).catch((error: unknown) => {
      if (!response.headersSent) {
        sendText({
          headOnly: request.method === 'HEAD',
          response,
          status: 500,
          text: 'Internal Server Error\n',
        });
      } else {
        response.destroy();
      }

      try {
        onError(error);
      } catch (reportingError) {
        logRequestError(reportingError);
      }
    });
  });
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  const { host, port } = serveStaticOptions();
  const server = createStaticServer();

  server.listen(port, host, () => {
    console.log(`[serve-static] Serving ${OUTPUT_DIR} at http://${host}:${port}`);
  });
}
