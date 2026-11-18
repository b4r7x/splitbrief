import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { stubSignInHome } from '#testing/helpers/sign-in-home.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { awaitBackgroundDiscovery } from '../../../src/cli/bootstrap/discovery.js';
import { initStoresForTuiMount } from '../../../src/cli/bootstrap/init.js';
import { createTuiCleanup } from '../../../src/cli/render/process-lifecycle.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';
import { readExecutableIdentity } from '../../../src/engine/runners/cli-executable/identity.js';
import { probeDeclaredCliReadinessEvidence } from '../../../src/engine/runners/cli-tools/probe/declared-readiness.js';
import { lookupCliReadinessProbe } from '../../../src/engine/runners/cli-tools/registry.js';

setupFetchMock();

function fakeTool(launches: string, tool: string, lines: readonly string[]): string {
  return [
    "const { appendFileSync } = require('node:fs');",
    "const args = process.argv.slice(2).join(' ');",
    `appendFileSync(${JSON.stringify(launches)}, ${JSON.stringify(tool)} + ' ' + args + '\\n');`,
    ...lines,
  ].join('\n');
}

// Each lane leaves a check that never answers: the readiness lane waits on the Claude Code sign-in
// status, the model-list lane on the Command Code model list. A third check, of Codex, has no
// signal from its caller, as a seat check of a run: only the quit stops it, else it goes on to the
// sign-in status once its version call ends. Each stage holds a copy of the sign-in state, and
// the quit must remove them without waiting for the check deadline.
it('removes the folders of the checks that a quit stops, sign-in copies included', async () => {
  await withTempDir('quit-probe-stages', async (dir) => {
    const projectDir = join(dir, 'project');
    const home = join(dir, 'home');
    const bin = join(dir, 'bin');
    // Off PATH, so no lane checks it.
    const runBin = join(dir, 'run-bin');
    const tmp = join(dir, 't');
    const launches = join(dir, 'launches');
    for (const path of [projectDir, bin, runBin, tmp]) mkdirSync(path);
    writeConfigYaml(projectDir, {
      planner: { kind: 'cli', tool: 'command-code' },
      implementer: { kind: 'shell', command: 'unused-implementer', model: 'fixture' },
    });
    writeFakeNodeCli(
      bin,
      'claude',
      fakeTool(launches, 'claude', [
        "if (args === '--version') { console.log('Claude Code " +
          CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion +
          "'); process.exit(0); }",
        "if (args !== 'auth status') process.exit(1);",
        'setInterval(() => {}, 1000);',
      ]),
    );
    writeFakeNodeCli(
      bin,
      'cmd',
      fakeTool(launches, 'cmd', [
        "if (process.argv.includes('--version')) { console.log('" +
          CLI_TOOL_CATALOG['command-code'].compatibility.testedVersion +
          "'); process.exit(0); }",
        "if (!process.argv.includes('--list-models')) process.exit(1);",
        'setInterval(() => {}, 1000);',
      ]),
    );
    writeFakeNodeCli(
      runBin,
      'codex',
      fakeTool(launches, 'codex', ['setInterval(() => {}, 1000);']),
    );
    await stubSignInHome(home, ['claude-code', 'command-code', 'codex']);
    vi.stubEnv('PATH', bin);
    vi.stubEnv('TMPDIR', tmp);
    resetAllStores();
    const stages = () => readdirSync(tmp).filter((name) => /^(splitbrief-|sb-)/.test(name));
    const signInCopies = () =>
      readdirSync(tmp, { recursive: true, encoding: 'utf8' }).filter((path) =>
        path.endsWith(join('.commandcode', 'auth.json')),
      );
    const cleanup = createTuiCleanup({ restore: vi.fn() });
    let awaitDiscovery: Promise<void> | undefined;
    try {
      ({ awaitDiscovery } = await initStoresForTuiMount(projectDir, { allowHooks: true }));
      const runCheck = probeDeclaredCliReadinessEvidence({
        tool: 'codex',
        executable: await readExecutableIdentity(join(runBin, 'codex')),
        probe: lookupCliReadinessProbe({ tool: 'codex', role: 'implementer' }),
      }).catch((error: unknown) => error);
      await vi.waitFor(() => {
        const started = existsSync(launches) ? readFileSync(launches, 'utf8').split('\n') : [];
        expect(started).toContain('claude auth status');
        expect(started).toContain('cmd --list-models --no-auto-update');
        expect(started).toContain('codex --version');
      });
      expect(stages()).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^splitbrief-readiness-/),
          expect.stringMatching(/^splitbrief-catalog-/),
        ]),
      );
      expect(signInCopies()).not.toEqual([]);
      const begin = performance.now();

      await cleanup();

      expect(performance.now() - begin).toBeLessThan(3_000);
      expect(stages()).toEqual([]);
      expect(await runCheck).toMatchObject({ name: 'AbortError' });
    } finally {
      try {
        await cleanup();
        await awaitDiscovery;
        await awaitBackgroundDiscovery();
      } finally {
        vi.unstubAllEnvs();
        resetAllStores();
      }
    }
  });
});
