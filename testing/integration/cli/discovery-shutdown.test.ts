import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { initStoresForTuiMount } from '../../../src/cli/bootstrap/init.js';
import { awaitBackgroundDiscovery } from '../../../src/cli/bootstrap/discovery.js';
import { createTuiCleanup } from '../../../src/cli/render/process-lifecycle.js';
import { getDefaultDetectionService } from '../../../src/engine/detection/service.js';
import { refreshDetectionForCurrentConfig } from '../../../src/engine/detection/store-publication.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool-catalog.js';
import { isNodeError } from '../../../src/lib/process/errors.js';
import { killAllProcesses, registeredProcessCount } from '../../../src/lib/process/registry.js';
import { configStore } from '../../../src/stores/project/config.js';
import { detectionStore } from '../../../src/stores/project/detection.js';

setupFetchMock();

describe('startup discovery shutdown', () => {
  it('reaps a sleeping probe and its group before quit completes, then starts no more probes', async () => {
    await withTempDir('discovery-shutdown', async (dir) => {
      const projectDir = join(dir, 'project');
      const home = join(dir, 'home');
      const bin = join(dir, 'bin');
      const started = join(bin, 'started');
      const authStarted = join(bin, 'auth-started');
      const releaseVersion = join(bin, 'release-version');
      const releaseAuth = join(bin, 'release-auth');
      const launches = join(bin, 'launches');
      for (const path of [projectDir, home, bin]) mkdirSync(path);
      writeConfigYaml(projectDir, {
        planner: { kind: 'cli', tool: 'claude-code', authChannel: 'api-key' },
        implementer: { kind: 'shell', command: 'unused-implementer', model: 'fixture' },
      });
      writeFakeNodeCli(
        bin,
        'claude',
        [
          "const { appendFileSync, existsSync, writeFileSync } = require('node:fs');",
          "const { spawn } = require('node:child_process');",
          `appendFileSync(${JSON.stringify(launches)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
          "const version = process.argv[2] === '--version';",
          "if (!version && process.argv.slice(2).join(' ') !== 'auth status') process.exit(1);",
          `const release = version ? ${JSON.stringify(releaseVersion)} : ${JSON.stringify(releaseAuth)};`,
          "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });",
          "process.on('SIGTERM', () => child.once('close', () => process.exit(0)));",
          `child.once('spawn', () => writeFileSync(version ? ${JSON.stringify(started)} : ${JSON.stringify(authStarted)}, process.pid + ' ' + child.pid));`,
          'const poll = setInterval(() => {',
          '  if (!existsSync(release)) return;',
          '  clearInterval(poll);',
          `  process.stdout.write(version ? ${JSON.stringify(`Claude Code ${CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion}\n`)} : 'Logged in\\n');`,
          "  child.once('close', () => process.exit(0));",
          "  child.kill('SIGTERM');",
          '}, 10);',
          'setTimeout(() => process.exit(0), 30000);',
        ].join('\n'),
      );
      vi.stubEnv('HOME', home);
      vi.stubEnv('XDG_CONFIG_HOME', join(home, 'config'));
      vi.stubEnv('XDG_CACHE_HOME', join(home, 'cache'));
      vi.stubEnv('XDG_DATA_HOME', join(home, 'data'));
      vi.stubEnv('PATH', bin);
      vi.stubEnv('GH_TOKEN', 'ghp_discovery_shutdown_fixture');
      vi.stubEnv('GITHUB_TOKEN', 'ghp_discovery_shutdown_fixture');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-discovery-shutdown-fixture');
      vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('{}'));
      resetAllStores();
      const restored = vi.fn();
      const cleanup = createTuiCleanup({ restore: restored });
      let awaitDiscovery: Promise<void> | undefined;
      let refresh: Promise<unknown> | undefined;
      try {
        ({ awaitDiscovery } = await initStoresForTuiMount(projectDir, { allowHooks: true }));
        await vi.waitFor(() => expect(existsSync(started)).toBe(true));
        writeFileSync(releaseVersion, 'release');
        await vi.waitFor(() => expect(existsSync(authStarted)).toBe(true));
        writeFileSync(releaseAuth, 'release');
        await awaitDiscovery;
        await awaitBackgroundDiscovery();
        expect(
          readFileSync(launches, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        ).toEqual([['--version'], ['auth', 'status']]);
        for (const path of [started, authStarted, releaseVersion, releaseAuth]) rmSync(path);
        const config = configStore.get().config;
        if (config === null) throw new Error('Missing bootstrap config');
        const refreshCurrent = () =>
          refreshDetectionForCurrentConfig({
            service: getDefaultDetectionService(),
            publication: detectionStore,
            getCurrent: () => ({ config, projectDir }),
          });
        refresh = refreshCurrent();
        await vi.waitFor(() => expect(existsSync(started)).toBe(true));
        const [pid, descendantPid] = readFileSync(started, 'utf8').split(' ').map(Number);
        if (pid === undefined || descendantPid === undefined) throw new Error('Missing probe PIDs');
        expect(pid).toBeGreaterThan(1);
        expect(descendantPid).toBeGreaterThan(1);
        expect(process.kill(pid, 0)).toBe(true);
        expect(process.kill(descendantPid, 0)).toBe(true);
        expect(process.kill(-pid, 0)).toBe(true);
        expect(registeredProcessCount()).toBeGreaterThan(0);
        const beforeQuit = readFileSync(launches, 'utf8');
        const begin = performance.now();

        await cleanup();

        expect(performance.now() - begin).toBeLessThan(3000);
        expect(restored).toHaveBeenCalledOnce();
        expect(registeredProcessCount()).toBe(0);
        for (const target of [pid, descendantPid, -pid]) {
          try {
            process.kill(target, 0);
            throw new Error(`Probe target ${target} survived cleanup`);
          } catch (error) {
            if (!isNodeError(error) || error.code !== 'ESRCH') throw error;
          }
        }

        await refresh;
        expect(existsSync(authStarted)).toBe(false);
        await refreshCurrent();
        await cleanup();
        expect(readFileSync(launches, 'utf8')).toBe(beforeQuit);
        expect(registeredProcessCount()).toBe(0);
        expect(restored).toHaveBeenCalledOnce();
      } finally {
        try {
          await getDefaultDetectionService().shutdown();
          await killAllProcesses();
          await cleanup();
          await awaitDiscovery;
          await refresh;
          await awaitBackgroundDiscovery();
        } finally {
          vi.unstubAllEnvs();
          resetAllStores();
        }
      }
    });
  });
});
