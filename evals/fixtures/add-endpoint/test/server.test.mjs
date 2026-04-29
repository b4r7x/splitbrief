import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixtureDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function readFixtureSource(path) {
  return readFile(join(fixtureDir, path), 'utf8');
}

test('fixture starts with an existing version route', async () => {
  const routes = await readFixtureSource('src/routes.ts');
  assert.match(routes, /path:\s*['"]\/api\/version['"]/);
  assert.match(routes, /version:\s*['"]1\.0\.0['"]/);
});

test('fixture server exposes route dispatch behavior', async () => {
  const server = await readFixtureSource('src/server.ts');
  assert.match(server, /export function handleRequest/);
  assert.match(server, /statusCode:\s*404/);
  assert.match(server, /route\.handler\(\)/);
});
