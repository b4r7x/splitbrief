// @vitest-environment node

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticServer } from './serve-static.js';

interface TestResponse {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}

let fixtureDirectory = '';
let port = 0;
let server: Server | undefined;
const serverErrors: unknown[] = [];

function requestPath(options: {
  readonly method?: string;
  readonly path: string;
  readonly requestPort?: number;
}): Promise<TestResponse> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        method: options.method ?? 'GET',
        path: options.path,
        port: options.requestPort ?? port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolveRequest({
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      },
    );

    request.on('error', rejectRequest);
    request.end();
  });
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'splitbrief-static-'));
  await mkdir(join(fixtureDirectory, 'guide'), { recursive: true });
  await mkdir(join(fixtureDirectory, 'api'), { recursive: true });
  await mkdir(join(fixtureDirectory, 'docs', 'getting-started'), { recursive: true });
  await Promise.all([
    writeFile(join(fixtureDirectory, 'index.html'), '<h1>Home shell</h1>'),
    writeFile(join(fixtureDirectory, 'guide', 'index.html'), 'guide index'),
    writeFile(join(fixtureDirectory, 'guide.html'), 'guide html'),
    writeFile(join(fixtureDirectory, 'about.html'), 'about page'),
    writeFile(join(fixtureDirectory, 'styles.css'), 'body { color: white; }'),
    writeFile(join(fixtureDirectory, 'api', 'search'), '{"results":[]}'),
    writeFile(
      join(fixtureDirectory, 'docs', 'getting-started', 'introduction.md'),
      '# Introduction\n',
    ),
    writeFile(join(fixtureDirectory, 'llms-full.txt'), '# SPLITBRIEF\n'),
    writeFile(join(fixtureDirectory, 'hello world.txt'), 'decoded path'),
    writeFile(join(fixtureDirectory, '404.html'), '<h1>Custom missing</h1>'),
    symlink('loop', join(fixtureDirectory, 'loop')),
  ]);

  server = createStaticServer({
    onError: (error) => serverErrors.push(error),
    rootDirectory: fixtureDirectory,
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server?.once('error', rejectListen);
    server?.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Static test server did not bind to a TCP port');
  }
  port = address.port;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolveClose, rejectClose) => {
      server?.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    });
  }
  await rm(fixtureDirectory, { force: true, recursive: true });
});

describe('built-output static server', () => {
  it('reports unexpected filesystem errors and returns 500', async () => {
    const response = await requestPath({ path: '/loop' });

    expect(response).toMatchObject({
      body: 'Internal Server Error\n',
      status: 500,
    });
    expect(serverErrors).toHaveLength(1);
    expect(serverErrors[0]).toBeInstanceOf(Error);
  });

  it('returns 500 even when the injected error reporter throws', async () => {
    let wasReported = false;
    const reportingServer = createStaticServer({
      onError: () => {
        wasReported = true;
        throw new Error('Reporter failed');
      },
      rootDirectory: fixtureDirectory,
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      reportingServer.once('error', rejectListen);
      reportingServer.listen(0, '127.0.0.1', resolveListen);
    });

    try {
      const address = reportingServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Reporting test server did not bind to a TCP port');
      }

      const response = await requestPath({
        path: '/loop',
        requestPort: address.port,
      });
      expect(response).toMatchObject({
        body: 'Internal Server Error\n',
        status: 500,
      });
      expect(wasReported).toBe(true);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        reportingServer.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
  });

  it('serves exact, directory-index, and extensionless HTML paths', async () => {
    const [home, guide, about, stylesheet, head] = await Promise.all([
      requestPath({ path: '/' }),
      requestPath({ path: '/guide' }),
      requestPath({ path: '/about' }),
      requestPath({ path: '/styles.css' }),
      requestPath({ method: 'HEAD', path: '/styles.css' }),
    ]);

    expect(home).toMatchObject({
      body: '<h1>Home shell</h1>',
      status: 200,
    });
    expect(home.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(guide.body).toBe('guide index');
    expect(about.body).toBe('about page');
    expect(stylesheet.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(head).toMatchObject({ body: '', status: 200 });
    expect(head.headers['content-length']).toBe(
      String(Buffer.byteLength('body { color: white; }')),
    );
  });

  it('serves markdown, text, and extensionless search output with explicit MIME types', async () => {
    const [markdown, llmsFull, search, decodedPath] = await Promise.all([
      requestPath({ path: '/docs/getting-started/introduction.md' }),
      requestPath({ path: '/llms-full.txt' }),
      requestPath({ path: '/api/search' }),
      requestPath({ path: '/hello%20world.txt' }),
    ]);

    expect(markdown).toMatchObject({ body: '# Introduction\n', status: 200 });
    expect(markdown.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(llmsFull).toMatchObject({ body: '# SPLITBRIEF\n', status: 200 });
    expect(llmsFull.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(search).toMatchObject({ body: '{"results":[]}', status: 200 });
    expect(search.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(decodedPath).toMatchObject({ body: 'decoded path', status: 200 });
    expect(decodedPath.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('redirects the exact docs root to a relative target without a trailing slash', async () => {
    const [plainRedirect, queryRedirect] = await Promise.all([
      requestPath({ path: '/docs' }),
      requestPath({ path: '/docs?from=test' }),
    ]);

    for (const redirect of [plainRedirect, queryRedirect]) {
      expect(redirect).toMatchObject({ body: '', status: 301 });
      expect(redirect.headers.location).toBe('/docs/getting-started/introduction');
    }
  });

  it('returns the built 404 without an SPA fallback and rejects unsafe or unsupported requests', async () => {
    const [
      missing,
      missingHead,
      missingMarkdown,
      missingText,
      missingSearch,
      trailingSlash,
      traversal,
      malformed,
      unsupported,
    ] = await Promise.all([
      requestPath({ path: '/missing' }),
      requestPath({ method: 'HEAD', path: '/missing' }),
      requestPath({ path: '/docs/missing.md' }),
      requestPath({ path: '/missing.txt' }),
      requestPath({ path: '/api/missing' }),
      requestPath({ path: '/styles.css/' }),
      requestPath({ path: '/%2e%2e%2foutside.txt' }),
      requestPath({ path: '/%E0%A4%A' }),
      requestPath({ method: 'POST', path: '/' }),
    ]);

    expect(missing).toMatchObject({
      body: '<h1>Custom missing</h1>',
      status: 404,
    });
    expect(missing.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(missingHead).toMatchObject({ body: '', status: 404 });
    for (const response of [missingMarkdown, missingText, missingSearch, trailingSlash]) {
      expect(response).toMatchObject({
        body: '<h1>Custom missing</h1>',
        status: 404,
      });
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    }
    expect(traversal).toMatchObject({ body: 'Bad Request\n', status: 400 });
    expect(malformed).toMatchObject({ body: 'Bad Request\n', status: 400 });
    expect(unsupported).toMatchObject({ body: 'Method Not Allowed\n', status: 405 });
    expect(unsupported.headers.allow).toBe('GET, HEAD');
  });

  it('keeps fallback candidates and symlink targets inside the static root', async () => {
    const boundaryRoot = join(fixtureDirectory, 'boundary');
    const outsideRoot = join(fixtureDirectory, 'outside');
    await mkdir(boundaryRoot);
    await mkdir(outsideRoot);
    await writeFile(`${boundaryRoot}.html`, 'escaped sibling');
    await writeFile(join(outsideRoot, 'secret.txt'), 'escaped symlink');
    await symlink(
      outsideRoot,
      join(boundaryRoot, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const boundaryServer = createStaticServer({ rootDirectory: boundaryRoot });
    await new Promise<void>((resolveListen, rejectListen) => {
      boundaryServer.once('error', rejectListen);
      boundaryServer.listen(0, '127.0.0.1', resolveListen);
    });

    try {
      const address = boundaryServer.address();
      if (!address || typeof address === 'string') {
        throw new Error('Boundary test server did not bind to a TCP port');
      }

      const [fallbackResponse, symlinkResponse] = await Promise.all([
        requestPath({ path: '/', requestPort: address.port }),
        requestPath({ path: '/linked/secret.txt', requestPort: address.port }),
      ]);

      expect(fallbackResponse).toMatchObject({ body: 'Not Found\n', status: 404 });
      expect(symlinkResponse).toMatchObject({ body: 'Not Found\n', status: 404 });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        boundaryServer.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    }
  });
});
