import { describe, expect, it } from 'vitest';
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
});

describe('rejectUntrustedRunners', () => {
  it('throws for repo-local commands without allowHooks', () => {
    const config = makeConfig(shellConfig('./scripts/evil'));
    expect(() => rejectUntrustedRunners(config, '/tmp/project', false)).toThrow(
      /repo-local runner/i,
    );
  });

  it('allows repo-local commands when allowHooks is true', () => {
    const config = makeConfig(shellConfig('./scripts/my-runner'));
    expect(() => rejectUntrustedRunners(config, '/tmp/project', true)).not.toThrow();
  });

  it('allows system commands without allowHooks', () => {
    const config = makeConfig(shellConfig('aider'));
    expect(() => rejectUntrustedRunners(config, '/tmp/project', false)).not.toThrow();
  });
});
