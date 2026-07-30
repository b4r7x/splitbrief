import { access, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { createStaticServer } from './serve-static.js';
import { OUTPUT_PATH, PUBLIC_PATH } from './site.js';
import { OG_HEIGHT, OG_WIDTH, validateOgFile } from './validate-og.js';

function collectRuntimeFailures(page: Page): string[] {
  const failures: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    failures.push(`page: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    failures.push(
      `request: ${request.url()} (${request.failure()?.errorText ?? 'unknown failure'})`,
    );
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failures.push(`response: ${response.status()} ${response.url()}`);
    }
  });

  return failures;
}

export async function generateOgImage(outputPath = resolve(PUBLIC_PATH, 'og.png')): Promise<void> {
  await access(resolve(OUTPUT_PATH, 'og/index.html'));
  await mkdir(dirname(outputPath), { recursive: true });

  const server = createStaticServer({ rootDirectory: OUTPUT_PATH });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('OG server did not bind to a TCP port');
  }

  try {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        viewport: { height: OG_HEIGHT, width: OG_WIDTH },
      });
      try {
        const page = await context.newPage();
        const runtimeFailures = collectRuntimeFailures(page);
        const response = await page.goto(`http://127.0.0.1:${address.port}/og`, {
          waitUntil: 'networkidle',
        });
        if (response?.status() !== 200) {
          throw new Error(`OG route returned ${response?.status() ?? 'no response'}`);
        }

        await page.evaluate(() => document.fonts.ready);
        if (runtimeFailures.length > 0) {
          throw new Error(`OG route failed to render:\n${runtimeFailures.join('\n')}`);
        }

        await page.screenshot({
          animations: 'disabled',
          path: outputPath,
          type: 'png',
        });
        await validateOgFile(outputPath);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    });
  }
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  await generateOgImage();
  process.stdout.write(`OG: public/og.png (${OG_WIDTH}x${OG_HEIGHT})\n`);
}
