import { afterEach, describe, expect, it } from 'vitest';
import type { CustomCommand } from '../../core/config/custom-commands.js';
import type { CliExecutableReceipt } from '../../core/discovery/detection.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  buildCustomRunnerDisclosure,
  formatCustomRunnerDisclosure,
} from './custom-runner-disclosure.js';
import { customRunnerSecurityPosture, inlineRunnerSecurityPosture } from './custom-trust.js';
import { resolveCustomExecutable } from './resolve-cli-executable.js';

const LITERAL_DISCLOSURE_EXECUTABLE = {
  path: '/opt/splitbrief/bin/disclosure-runner',
  fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
  executableIdentity: {
    canonicalPath: '/opt/splitbrief/bin/disclosure-runner',
    realPath: '/opt/splitbrief/bin/disclosure-runner',
    platformFileId: '1:2',
    fingerprint: '1:2:3:4:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    resolvedAt: 5,
  },
} satisfies CliExecutableReceipt;

const LITERAL_DISCLOSURE_FIXTURES = [
  {
    source: 'configured',
    role: 'planner',
    contract: 'output',
    expected: `Executable: "/opt/splitbrief/bin/disclosure-runner"
Arguments: "--input" "task.md"
Contract: output
Working directory: Disposable staged project
Staging: Filtered disposable stage
Environment names: "REVIEW_TOKEN"
Environment access: Declared environment references only
Filesystem: Not an OS sandbox; the process can access files available to the current user
Network: Network access is not restricted
Result: Parsed output only; stage-local writes are discarded`,
  },
  {
    source: 'configured',
    role: 'planner',
    contract: 'direct',
    expected: `Executable: "/opt/splitbrief/bin/disclosure-runner"
Arguments: "--input" "task.md"
Contract: direct
Working directory: Disposable staged project
Staging: Filtered disposable stage
Environment names: "REVIEW_TOKEN"
Environment access: Declared environment references only
Filesystem: Not an OS sandbox; the process can access files available to the current user
Network: Network access is not restricted
Result: Reviewed declared artifact for normal planner calls; reviewed workspace diff for full escalation only`,
  },
  {
    source: 'configured',
    role: 'implementer',
    contract: 'output',
    expected: `Executable: "/opt/splitbrief/bin/disclosure-runner"
Arguments: "--input" "task.md"
Contract: output
Working directory: Disposable staged project
Staging: Filtered disposable stage
Environment names: "REVIEW_TOKEN"
Environment access: Declared environment references only
Filesystem: Not an OS sandbox; the process can access files available to the current user
Network: Network access is not restricted
Result: Parsed output only; stage-local writes are discarded`,
  },
  {
    source: 'configured',
    role: 'implementer',
    contract: 'direct',
    expected: `Executable: "/opt/splitbrief/bin/disclosure-runner"
Arguments: "--input" "task.md"
Contract: direct
Working directory: Disposable staged project
Staging: Filtered disposable stage
Environment names: "REVIEW_TOKEN"
Environment access: Declared environment references only
Filesystem: Not an OS sandbox; the process can access files available to the current user
Network: Network access is not restricted
Result: Reviewed diff only`,
  },
  {
    source: 'inline',
    role: 'planner',
    contract: 'output',
    expected: `Executable: "/opt/splitbrief/bin/disclosure-runner"
Arguments: "--input" "task.md"
Contract: output
Working directory: Project directory
Staging: None
Environment names: "REVIEW_TOKEN"
Environment access: Inherits the full SPLITBRIEF process environment, including credentials
Filesystem: Not an OS sandbox; the process can access files available to the current user
Network: Network access is not restricted
Result: Parsed stdout only; anything it writes in the project is neither staged nor reviewed`,
  },
  {
    source: 'inline',
    role: 'implementer',
    contract: 'direct',
    expected: `Executable: "/opt/splitbrief/bin/disclosure-runner"
Arguments: "--input" "task.md"
Contract: direct
Working directory: Project directory
Staging: None
Environment names: "REVIEW_TOKEN"
Environment access: Inherits the full SPLITBRIEF process environment, including credentials
Filesystem: Not an OS sandbox; the process can access files available to the current user
Network: Network access is not restricted
Result: Reviewed workspace diff; it writes directly into the project directory`,
  },
] as const;

let directories: string[] = [];

function command(overrides: Partial<CustomCommand> = {}): CustomCommand {
  return {
    id: 'review',
    label: 'Review changes',
    contract: 'output',
    executable: process.execPath,
    argv: ['--input', 'task.md'],
    outputFormat: 'text',
    idleWarnMs: 300_000,
    idleKillMs: 1_800_000,
    env: ['REVIEW_TOKEN'],
    ...overrides,
  };
}

function runner(customCommand = command(), source: 'configured' | 'inline' = 'configured') {
  return { source, command: customCommand };
}

async function executable(projectDir: string) {
  const resolution = await resolveCustomExecutable({ command: process.execPath, projectDir });
  if (resolution.kind !== 'resolved') throw new Error('Node executable did not resolve');
  return resolution.executable;
}

afterEach(() => {
  for (const directory of directories) cleanupTempDir(directory);
  directories = [];
});

describe('custom runner disclosure', () => {
  it.each(LITERAL_DISCLOSURE_FIXTURES)(
    'renders the complete $source $role $contract disclosure literal',
    ({ source, role, contract, expected }) => {
      const disclosure = buildCustomRunnerDisclosure({
        runner: runner(
          command({
            id: `${source}-${role}-${contract}-literal-disclosure`,
            contract,
            executable: LITERAL_DISCLOSURE_EXECUTABLE.path,
          }),
          source,
        ),
        posture:
          source === 'configured'
            ? customRunnerSecurityPosture(role, contract)
            : inlineRunnerSecurityPosture(role, contract),
        executable: LITERAL_DISCLOSURE_EXECUTABLE,
      });

      expect(disclosure).not.toBeNull();
      if (disclosure === null) throw new Error('literal disclosure fixture was rejected');
      expect(formatCustomRunnerDisclosure(disclosure)).toBe(expected);
    },
  );

  it('escapes executable and argv controls and exposes env names without values', async () => {
    const projectDir = createTempDir('custom-trust-disclosure-project');
    directories.push(projectDir);
    const credential = 'must-not-appear-value';
    const previousCredential = process.env.REVIEW_TOKEN;
    process.env.REVIEW_TOKEN = credential;
    try {
      const customCommand = command({
        argv: ['--title=\u001b]8;;https://example.com\u0007click\u001b]8;;\u0007', 'line\nnext'],
      });
      const disclosure = buildCustomRunnerDisclosure({
        runner: runner(customCommand),
        posture: customRunnerSecurityPosture('planner', 'output'),
        executable: await executable(projectDir),
      });
      expect(disclosure).not.toBeNull();
      if (disclosure === null) throw new Error('disclosure fixture was rejected');
      const formatted = formatCustomRunnerDisclosure(disclosure);

      expect(formatted).not.toContain('\u001b');
      expect(formatted).not.toContain('\u0007');
      expect(formatted).toContain('\\u001b');
      expect(formatted).toContain('\\n');
      expect(formatted).toContain('"REVIEW_TOKEN"');
      expect(formatted).not.toContain(credential);
      expect(formatted).toContain('Not an OS sandbox');
      expect(formatted).toContain('Network access is not restricted');
    } finally {
      if (previousCredential === undefined) delete process.env.REVIEW_TOKEN;
      else process.env.REVIEW_TOKEN = previousCredential;
    }
  });
});
