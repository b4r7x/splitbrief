import { chmodSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCandidateEvidenceCapture } from '../../providers/candidate-contract.js';
import { prependPath } from '#testing/helpers/command-shim.js';
import { CLI_CONFORMANCE_CANDIDATES as claudeCodeCandidates } from './claude-code.js';
import { CLI_CONFORMANCE_CANDIDATES as codexCandidates } from './codex.js';
import { CLI_CONFORMANCE_CANDIDATES as opencodeCandidates } from './opencode.js';
import { CLI_CONFORMANCE_CANDIDATES as aiderCandidates } from './aider.js';
import { CLI_CONFORMANCE_CANDIDATES as copilotCandidates } from './copilot.js';
import { CLI_CONFORMANCE_CANDIDATES as kiloCodeCandidates } from './kilo-code.js';
import type { RawCliCandidateContract, UnregisteredCliCandidate } from './candidate-contract.js';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  runProductionCliConformance,
  runRawCliConformance,
  type CliConformanceRole,
} from './contract-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const itUnix = process.platform === 'win32' ? it.skip : it;

type ConformanceModule = Readonly<{
  modulePath: string;
  candidates: readonly UnregisteredCliCandidate[];
}>;

const CONFORMANCE_MODULES: readonly ConformanceModule[] = [
  { modulePath: join(here, 'claude-code.ts'), candidates: claudeCodeCandidates },
  { modulePath: join(here, 'codex.ts'), candidates: codexCandidates },
  { modulePath: join(here, 'opencode.ts'), candidates: opencodeCandidates },
  { modulePath: join(here, 'aider.ts'), candidates: aiderCandidates },
  { modulePath: join(here, 'copilot.ts'), candidates: copilotCandidates },
  { modulePath: join(here, 'kilo-code.ts'), candidates: kiloCodeCandidates },
];

const CONFORMANCE_ROWS = CONFORMANCE_MODULES.flatMap((module) =>
  module.candidates.map((candidate) => ({
    ...candidate,
    modulePath: module.modulePath,
  })),
);

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
    transport: 'argv',
    terminal: 'turn.completed',
  },
  copilot: {
    versionLine: 'copilot 0.3.0',
    transport: 'argv',
    terminal: 'process-exit',
  },
  aider: {
    versionLine: 'aider 0.86.0',
    transport: 'argv',
    terminal: 'process-exit',
  },
  opencode: {
    versionLine: 'opencode 0.5.0',
    transport: 'argv',
    terminal: 'process-exit',
  },
  kilo: {
    versionLine: 'kilo 0.1.0',
    transport: 'argv',
    terminal: 'process-exit',
  },
};

const CREDENTIAL_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'claude-code': { ANTHROPIC_API_KEY: 'sk-ant-conformance-canary' },
  codex: { OPENAI_API_KEY: 'sk-openai-conformance-canary' },
  copilot: { GITHUB_TOKEN: 'ghp-conformance-canary' },
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
    profile.transport === 'stdin'
      ? ['PROMPT=$(cat)', `printf '%s\\n' '${resultLine.replace(/'/g, "'\\''")}'`].join('\n')
      : profile.terminal === 'turn.completed'
        ? `printf '%s\\n' '${codexLine.replace(/'/g, "'\\''")}'`
        : profile.terminal === 'result'
          ? `printf '%s\\n' '${resultLine.replace(/'/g, "'\\''")}'`
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

function rowKey(id: string, role: CliConformanceRole): string {
  return `${id}:${role}`;
}

const PROMPT_ARGV_LONG_HEAD = 'HEAD_SENTINEL ';
const PROMPT_ARGV_LONG_TAIL = ' TAIL_SENTINEL';
const PROMPT_ARGV_OVERSIZED = PROMPT_ARGV_LONG_HEAD + 'x'.repeat(200_000) + PROMPT_ARGV_LONG_TAIL;

function buildConformanceAdapterArgs(
  row: (typeof CONFORMANCE_ROWS)[number],
  prompt: string,
): readonly string[] {
  const input =
    row.role === 'planner'
      ? {
          prompt,
          model: undefined,
          projectDir: '/tmp',
          configuredArgs: [] as const,
          mode: 'plan' as const,
          sessionId: null,
          effort: undefined,
        }
      : { prompt, model: undefined, projectDir: '/tmp', configuredArgs: [] as const };
  const result = Reflect.apply(row.adapter.buildArgs, undefined, [input]);
  if (!Array.isArray(result) || !result.every((value) => typeof value === 'string')) {
    throw new Error(`adapter buildArgs returned invalid args for ${row.id} ${row.role}`);
  }
  return [...result];
}

describe('existing CLI prompt argv transport contract', () => {
  it.each(CONFORMANCE_ROWS.filter((row) => row.rawContract.promptTransport === 'argv'))(
    '$id $role keeps an oversized prompt byte-for-byte in argv for adapter pre-spawn rejection',
    (row) => {
      const args = buildConformanceAdapterArgs(row, PROMPT_ARGV_OVERSIZED);
      expect(args).toContain(PROMPT_ARGV_OVERSIZED);
      expect(args.find((arg) => arg.includes(PROMPT_ARGV_LONG_HEAD))).toBe(PROMPT_ARGV_OVERSIZED);
      expect(args.find((arg) => arg.includes(PROMPT_ARGV_LONG_TAIL))).toBe(PROMPT_ARGV_OVERSIZED);
    },
  );
});

describe('existing CLI common contract', () => {
  it('imports exactly 12 unique planner-then-implementer conformance rows', () => {
    expect(CONFORMANCE_ROWS).toHaveLength(12);
    const keys = CONFORMANCE_ROWS.map((row) => rowKey(row.id, row.role));
    expect(new Set(keys).size).toBe(12);
    for (const module of CONFORMANCE_MODULES) {
      expect(module.candidates).toHaveLength(2);
      expect(module.candidates.map((candidate) => candidate.role)).toEqual([
        'planner',
        'implementer',
      ]);
    }
  });

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
