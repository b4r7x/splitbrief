import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { loadRememberedSnapshot } from '../../../src/engine/detection/cache.js';
import { createDetectionService } from '../../../src/engine/detection/service.js';
import { refreshDetectionForCurrentConfig } from '../../../src/engine/detection/store-publication.js';
import { detectionStore } from '../../../src/stores/discovery/detection.js';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { activateSafeCliShimPath } from '#testing/helpers/compatible-cli-shim.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { useTrustHome as createTrustHome } from '#testing/helpers/trust-home.js';
import {
  cli,
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const TEXT_ONLY_MODEL = 'opencode-go/qwen3.7-max';
const IMAGE_NOTE =
  'The review seat, OpenCode CLI, cannot see images. The criteria of render checks cannot pass with this seat. In Settings > Crew > REVIEW, change the review seat to a tool that reads images.';

let fixture: StopContinueFixture | undefined;
let restorePath: (() => void) | undefined;
let trustHome: ReturnType<typeof createTrustHome> | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  restorePath?.();
  trustHome?.restore();
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  resetAllStores();
  fixture = undefined;
  restorePath = undefined;
  trustHome = undefined;
});

function projectWithOpenCodeSeats(): StopContinueFixture {
  const target = createStopContinueFixture(() => '', { isolation: 'none' });
  fixture = target;
  trustHome = createTrustHome('e2e-doctor-image-fact-home');
  const bin = join(target.tmpDir, 'bin');
  mkdirSync(bin);
  writeFakeNodeCli(
    bin,
    'opencode',
    `const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('${CLI_TOOL_CATALOG.opencode.compatibility.testedVersion}');
} else if (args[0] === 'auth' && args[1] === 'list') {
  console.log(JSON.stringify([{ name: 'OpenCode Go', connections: [{ type: 'credential' }] }]));
} else if (args.slice(0, 3).join(' ') === 'api GET /api/model') {
  console.log(JSON.stringify({ data: [{ id: 'qwen3.7-max', providerID: 'opencode-go', capabilities: { input: ['text'] } }] }));
} else {
  console.error('Unexpected opencode arguments: ' + args.join(' '));
  process.exitCode = 1;
}`,
  );
  restorePath = activateSafeCliShimPath(bin);
  const offline = join(target.tmpDir, 'offline.mjs');
  writeFileSync(
    offline,
    "globalThis.fetch = async () => { throw new Error('Network disabled in the doctor image fact scenario'); };\n",
  );
  vi.stubEnv('NODE_OPTIONS', `--import=${offline}`);
  vi.stubGlobal('fetch', async () => {
    throw new Error('Network disabled in the doctor image fact scenario');
  });

  const config = loadConfig(target.projectDir).config;
  const seat = { kind: 'cli', tool: 'opencode', model: TEXT_ONLY_MODEL } as const;
  writeConfig(target.projectDir, {
    ...config,
    planner: seat,
    implementer: seat,
    reviewer: seat,
    validation: { ...config.validation, render: 'npm run shots' },
  });
  return target;
}

/** The detection pass an earlier TUI session runs: it lists the tool's models and saves the record. */
async function rememberToolListing(projectDir: string): Promise<void> {
  const config = loadConfig(projectDir).config;
  const service = createDetectionService();
  await refreshDetectionForCurrentConfig({
    service,
    publication: detectionStore,
    getCurrent: () => ({ config, projectDir }),
  });
  await service.getPendingSave();
  await service.shutdown();
}

function reviewDetail(stdout: string): string | undefined {
  const lines = stripVTControlCharacters(stdout).split('\n');
  const review = lines.findIndex((line) => /^\s*ok\s+REVIEW OpenCode CLI/u.test(line));
  expect(review, stdout).toBeGreaterThan(-1);
  return lines[review + 1]?.trim();
}

it('tells the user on the REVIEW line that a remembered text-only OpenCode model cannot see the renders', async () => {
  const target = projectWithOpenCodeSeats();

  const noRecord = await cli(target, ['doctor']);
  expect(noRecord.stdout, noRecord.stderr).toContain('REVIEW OpenCode CLI');
  expect(noRecord.stdout).not.toContain('cannot see images');

  await rememberToolListing(target.projectDir);
  const snapshot = await loadRememberedSnapshot(target.projectDir);
  expect(
    snapshot?.cliCatalogs?.map(({ tool, models }) => ({ tool, ids: models.map((m) => m.id) })),
  ).toEqual([{ tool: 'opencode', ids: [TEXT_ONLY_MODEL] }]);

  const remembered = await cli(target, ['doctor']);
  expect(reviewDetail(remembered.stdout), remembered.stderr).toBe(IMAGE_NOTE);
});
