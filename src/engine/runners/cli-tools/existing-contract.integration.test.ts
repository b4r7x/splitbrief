import { chmodSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFORMANCE_ROWS } from '#testing/helpers/cli-conformance-rows.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import { createCandidateEvidenceCapture } from '../../providers/candidate/evidence.js';
import type { RawCliCandidateContract } from './candidate-contract.js';
import { CLI_CONFORMANCE_EXIT_CODES, type CliConformanceRole } from './contract-harness/harness.js';
import { runProductionCliConformance } from './contract-harness/production.js';
import { runRawCliConformance } from './contract-harness/raw.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

type ShimProfile = Readonly<{
  versionLine: string;
  transport: RawCliCandidateContract['promptTransport'];
  terminal: RawCliCandidateContract['expectedRawTerminal'];
}>;

const SHIM_PROFILES: Readonly<Record<string, ShimProfile>> = {
  claude: {
    versionLine: 'claude 2.0.0',
    transport: 'stdin',
    terminal: 'result',
  },
  codex: {
    versionLine: 'codex 0.40.0',
    transport: 'stdin',
    terminal: 'turn.completed',
  },
  copilot: {
    versionLine: 'copilot 0.3.0',
    transport: 'stdin',
    terminal: 'process-exit',
  },
  opencode: {
    versionLine: 'opencode 0.5.0',
    transport: 'stdin',
    terminal: 'process-exit',
  },
  kilo: {
    versionLine: 'kilo 0.1.0',
    transport: 'stdin',
    terminal: 'process-exit',
  },
  'cursor-agent': {
    versionLine: '2026.08.25-3e8eec8',
    transport: 'stdin',
    terminal: 'result',
  },
  cmd: {
    versionLine: '1.4.0',
    transport: 'stdin',
    terminal: 'result',
  },
};

const CREDENTIAL_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'claude-code': { ANTHROPIC_API_KEY: 'sk-ant-conformance-canary' },
  codex: { OPENAI_API_KEY: 'sk-openai-conformance-canary' },
  copilot: { GITHUB_TOKEN: 'ghp-conformance-canary' },
  cursor: { CURSOR_API_KEY: 'sk-cursor-conformance-canary' },
};

function rawContractForHarness(contract: RawCliCandidateContract): RawCliCandidateContract {
  return {
    ...contract,
    auth: { kind: 'env-only', env: [...contract.auth.env] },
  };
}

async function persistHarnessRawEvidence(
  recordPath: string,
  row: (typeof CONFORMANCE_ROWS)[number],
): Promise<void> {
  const parsed = JSON.parse(await readFile(recordPath, 'utf8')) as {
    rawCapture: { stdout: string; stderr: string };
  };
  await writeFile(
    recordPath,
    `${JSON.stringify(
      {
        rawCapture: createCandidateEvidenceCapture({
          candidateId: row.id,
          role: row.role,
          contractSha256: row.contractSha256,
          stdout: parsed.rawCapture.stdout,
          stderr: parsed.rawCapture.stderr,
        }),
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(recordPath, 0o600);
}

function writeConformanceShim(
  directory: string,
  command: string,
  profile: ShimProfile,
  role: CliConformanceRole,
): void {
  const resultLine = JSON.stringify({
    type: 'result',
    result: 'done',
    session_id: 'sess-conformance',
  });
  const cursorNdjson = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'contract-session' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
  ]
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  const commandCodeNdjson = [
    JSON.stringify({
      type: 'event',
      event: {
        type: 'tool_queued',
        toolCallId: 'call_1',
        toolName: 'read_file',
        input: { file_path: 'README.md' },
      },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      sessionId: 'contract-session',
      stopReason: 'end_turn',
      finalText: 'done',
      usage: { inputTokens: 10, outputTokens: 2 },
    }),
  ]
    .map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`)
    .join('\n');
  const codexLine = JSON.stringify({ type: 'turn.completed' });
  const bashFirstArg = '$' + '{1:-}';
  const body = [
    '#!/bin/bash',
    'set -euo pipefail',
    'MARKER=conformance-change.txt',
    `if [ "${bashFirstArg}" = "--version" ]; then`,
    `  printf '%s\\n' '${profile.versionLine.replace(/'/g, "'\\''")}'`,
    '  exit 0',
    'fi',
    `if [ "${bashFirstArg}" = "auth" ]; then`,
    "  printf '%s\\n' 'authenticated'",
    '  exit 0',
    'fi',
    profile.transport === 'stdin' ? 'PROMPT=$(cat)' : '',
    profile.terminal === 'turn.completed'
      ? `printf '%s\\n' '${codexLine.replace(/'/g, "'\\''")}'`
      : profile.terminal === 'result'
        ? command === 'cursor-agent'
          ? cursorNdjson
          : command === 'cmd'
            ? commandCodeNdjson
            : `printf '%s\\n' '${resultLine.replace(/'/g, "'\\''")}'`
        : "printf '%s\\n' 'ok'",
    role === 'implementer' ? 'printf changed > "$MARKER"' : '',
    'exit 0',
    '',
  ].join('\n');
  const shimPath = join(directory, command);
  writeFileSync(shimPath, body, { encoding: 'utf8', mode: 0o600 });
  chmodSync(shimPath, 0o755);
}

const tempDirectories: string[] = [];
const restorePathHooks: Array<() => void> = [];

afterEach(async () => {
  while (restorePathHooks.length > 0) {
    const restore = restorePathHooks.pop();
    restore?.();
  }
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

describe('existing CLI common contract', () => {
  itUnix.each(CONFORMANCE_ROWS)(
    '$id $role captures raw evidence then reuses it in production harness',
    async (row) => {
      const directory = await temporaryDirectory('splitbrief-cli-existing-contract-');
      const shimDir = await temporaryDirectory('splitbrief-cli-existing-shim-');
      const profile = SHIM_PROFILES[row.rawContract.command];
      if (profile === undefined) {
        throw new Error(`missing shim profile for ${row.rawContract.command}`);
      }
      writeConformanceShim(shimDir, row.rawContract.command, profile, 'planner');
      restorePathHooks.push(prependPath(shimDir));

      const recordPath = join(directory, `${row.id}-${row.role}.json`);
      const environment = CREDENTIAL_ENV[row.id];

      const raw = await runRawCliConformance({
        contractJson: JSON.stringify(rawContractForHarness(row.rawContract)),
        recordPath,
        projectDir: directory,
        environment,
      });
      expect(raw.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      expect(raw.candidateId).toBe(row.id);
      expect(raw.role).toBe(row.role);

      const rawEvidence = JSON.parse(await readFile(recordPath, 'utf8')) as {
        rawCapture: {
          candidateId: string;
          role: CliConformanceRole;
          contractSha256: string;
        };
      };
      expect(Object.keys(rawEvidence)).toEqual(['rawCapture']);
      expect(rawEvidence.rawCapture).toMatchObject({
        candidateId: row.id,
        role: row.role,
      });

      await persistHarnessRawEvidence(recordPath, row);
      expect(JSON.parse(await readFile(recordPath, 'utf8')).rawCapture.contractSha256).toBe(
        row.contractSha256,
      );

      if (row.role === 'implementer') {
        writeConformanceShim(shimDir, row.rawContract.command, profile, 'implementer');
      }

      const production = await runProductionCliConformance({
        modulePath: row.modulePath,
        role: row.role,
        recordPath,
        projectDir: directory,
        environment,
      });
      expect(production.exitCode).toBe(CLI_CONFORMANCE_EXIT_CODES.PASS);
      expect(production.candidateId).toBe(row.id);
      expect(production.role).toBe(row.role);

      const evidence = JSON.parse(await readFile(recordPath, 'utf8')) as {
        rawCapture: { candidateId: string; role: CliConformanceRole; contractSha256: string };
        productionConformance: {
          candidateId: string;
          role: CliConformanceRole;
          contractSha256: string;
        };
        verdict: string;
      };
      expect(evidence.verdict).toBe('PASS');
      expect(evidence.productionConformance).toMatchObject({
        candidateId: row.id,
        role: row.role,
        contractSha256: row.contractSha256,
      });
      expect(evidence.rawCapture.contractSha256).toBe(row.contractSha256);
      expect(evidence.rawCapture.candidateId).toBe(row.id);
      expect(evidence.rawCapture.role).toBe(row.role);
    },
  );
});
