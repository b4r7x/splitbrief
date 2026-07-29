import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRunnerTrust, rejectUntrustedRunners } from './trust.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { Config } from '../../core/schemas/config.js';

function shellConfig(command: string): Partial<Config> {
  return {
    implementer: {
      kind: 'shell',
      command,
      model: 'test-model',
    } as Config['implementer'],
  };
}

describe('checkRunnerTrust', () => {
  it('trusts system commands like claude and codex', () => {
    const config = makeConfig(shellConfig('claude'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('trusts node, npx, and other common tools', () => {
    for (const cmd of ['node', 'npx', 'npm', 'python', 'python3', 'cargo', 'go']) {
      const config = makeConfig(shellConfig(cmd));
      const result = checkRunnerTrust(config, '/tmp/project');
      expect(result.untrustedCommands).toEqual([]);
    }
  });

  it('flags package-manager script execution as repo-local execution', () => {
    const config = makeConfig(shellConfig('npm run build'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('npm run build');
  });

  it('flags bare commands that PATH resolves inside the project', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-runner-trust-'));
    const savedPath = process.env['PATH'];
    try {
      const binDir = join(projectDir, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      const runner = join(binDir, 'local-runner');
      writeFileSync(runner, '#!/bin/sh\n');
      chmodSync(runner, 0o755);
      process.env['PATH'] = [binDir, savedPath].filter(Boolean).join(delimiter);

      const config = makeConfig(shellConfig('local-runner'));
      const result = checkRunnerTrust(config, projectDir);
      expect(result.untrustedCommands).toContain('local-runner');
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('flags relative-path commands as untrusted', () => {
    const config = makeConfig(shellConfig('./scripts/my-runner'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('./scripts/my-runner');
  });

  it('flags bare repo-relative script paths as untrusted', () => {
    const config = makeConfig(shellConfig('scripts/runner.sh'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('scripts/runner.sh');
  });

  it('flags interpreter args pointing at repo-local scripts as untrusted', () => {
    const config = makeConfig(shellConfig('node scripts/malicious.js'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('node scripts/malicious.js');
  });

  it('does not flag interpreter eval text that mentions repo paths', () => {
    const config = makeConfig(shellConfig('node -e process.stdout.write("file: src/hello.ts")'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('flags repo-local paths embedded in --flag=path tokens as untrusted', () => {
    for (const flag of ['--import=./scripts/evil.js', '--require=./x.js']) {
      const config = makeConfig(shellConfig(`node ${flag}`));
      const result = checkRunnerTrust(config, '/tmp/project');
      expect(result.untrustedCommands).toContain(`node ${flag}`);
    }
  });

  it('does not flag --flag=path tokens pointing outside the project dir', () => {
    const config = makeConfig(shellConfig('node --import=/usr/local/lib/safe.js'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('does not flag value-less flags', () => {
    const config = makeConfig(shellConfig('node --enable-source-maps'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('flags parent-relative commands as untrusted', () => {
    const config = makeConfig(shellConfig('../other/runner'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('../other/runner');
  });

  it('flags absolute paths inside project dir as untrusted', () => {
    const config = makeConfig(shellConfig('/tmp/project/bin/runner'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toContain('/tmp/project/bin/runner');
  });

  it('does not flag absolute paths outside project dir', () => {
    const config = makeConfig(shellConfig('/usr/local/bin/some-tool'));
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('ignores non-shell/agent runners', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'test',
        apiBase: 'http://localhost:11434/v1',
      },
    });
    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.untrustedCommands).toEqual([]);
  });

  it('flags repo-local implementer profile commands', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'ollama',
        model: 'test',
        apiBase: 'http://localhost:11434/v1',
      },
      implementerProfiles: {
        default: 'safe',
        profiles: {
          safe: {
            kind: 'api',
            provider: 'ollama',
            model: 'test',
            apiBase: 'http://localhost:11434/v1',
          },
          local: {
            kind: 'agent',
            command: './scripts/agent',
            model: 'agent-default',
          },
        },
      },
    });

    const result = checkRunnerTrust(config, '/tmp/project');
    expect(result.violations).toContainEqual({
      label: 'implementer profile local',
      command: './scripts/agent',
    });
  });

  it('flags shell-evaluated prompt placeholders for agent implementers', () => {
    const config = makeConfig({
      implementer: {
        kind: 'agent',
        command: 'bash',
        args: ['-c', 'printf "%s" "{prompt}"'],
        model: 'agent-default',
      },
    });

    expect(checkRunnerTrust(config, '/tmp/project').untrustedCommands).toContain(
      'bash -c printf "%s" "{prompt}"',
    );
  });
});

describe('rejectUntrustedRunners', () => {
  it('throws for repo-local commands without allowRepoRunners', () => {
    const config = makeConfig(shellConfig('./scripts/evil'));
    expect(() => rejectUntrustedRunners(config, '/tmp/project', false)).toThrow(
      /untrusted runner/i,
    );
  });

  it('allows repo-local commands when allowRepoRunners is true', () => {
    const config = makeConfig(shellConfig('./scripts/my-runner'));
    expect(() => rejectUntrustedRunners(config, '/tmp/project', true)).not.toThrow();
  });

  it('allows system commands without allowHooks', () => {
    const config = makeConfig(shellConfig('aider'));
    expect(() => rejectUntrustedRunners(config, '/tmp/project', false)).not.toThrow();
  });
});
