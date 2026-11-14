import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { writeFakeNodeCli } from '#testing/helpers/command-shim.js';
import { hermeticPath } from '#testing/helpers/compatible-cli-shim.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { CLI_TOOL_CATALOG } from '../../../src/core/runners/cli-tool/catalog.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('the slow tool check line', { timeout: 90_000 }, () => {
  it('doctor --json writes the line on stderr and keeps one JSON object on stdout', async () => {
    await withTempDir('slow-probe-line', async (dir) => {
      const projectDir = join(dir, 'project');
      const home = join(dir, 'home');
      const bin = join(dir, 'bin');
      const release = join(dir, 'release-version');
      for (const path of [projectDir, home, bin]) mkdirSync(path);
      writeConfigYaml(projectDir, {
        planner: { kind: 'cli', tool: 'claude-code' },
        implementer: { kind: 'shell', command: 'unused-implementer', model: 'fixture' },
      });
      writeFakeNodeCli(
        bin,
        'claude',
        [
          "const { existsSync } = require('node:fs');",
          "const args = process.argv.slice(2).join(' ');",
          "if (args === 'auth status') { process.stdout.write('Logged in\\n'); process.exit(0); }",
          "if (args !== '--version') process.exit(1);",
          'const poll = setInterval(() => {',
          `  if (!existsSync(${JSON.stringify(release)})) return;`,
          '  clearInterval(poll);',
          `  process.stdout.write(${JSON.stringify(`Claude Code ${CLI_TOOL_CATALOG['claude-code'].compatibility.testedVersion}\n`)});`,
          '}, 10);',
        ].join('\n'),
      );

      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', 'doctor', '--json', '--project', projectDir],
        {
          cwd: repoRoot,
          env: {
            PATH: hermeticPath([bin]),
            HOME: home,
            XDG_CONFIG_HOME: join(home, 'config'),
            XDG_CACHE_HOME: join(home, 'cache'),
            XDG_DATA_HOME: join(home, 'data'),
            NODE_NO_WARNINGS: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));

      try {
        await vi.waitFor(
          () => expect(stderr).toContain('Checking tools · Claude Code CLI version 10s\n'),
          { timeout: 60_000, interval: 100 },
        );
      } finally {
        writeFileSync(release, 'release');
      }
      await exited;

      expect(stdout).not.toContain('Checking tools');
      const report: unknown = JSON.parse(stdout);
      expect(typeof report).toBe('object');
    });
  });
});
