import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  STALE_CONSULT_ANSWER_JSON_SCHEMA,
  StaleConsultAnswerSchema,
} from '../../../../src/core/schemas/consult.js';
import { createCliPlanner } from '../../../../src/engine/planners/cli.js';
import { createClaudeCodePlanner } from '../../../../src/engine/planners/claude-code.js';
import { resolveCliExecutable } from '../../../../src/engine/runners/resolve-cli-executable.js';
import { requestTyped } from '../../../../src/engine/runners/typed-output.js';
import { redactPublicPayload } from '../../../../src/core/payload-bounds.js';
import { isRecord } from '../../../../src/utils/type-guards.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { liveToolBlocker } from '../../helpers/live-harness.js';

const itLive = process.env.SPLITBRIEF_REAL_CLI_E2E === '1' ? it : it.skip;

type Probe = Readonly<{
  prompt: string;
  schema: z.ZodType<unknown>;
  jsonSchema: Readonly<Record<string, unknown>>;
  schemaName: string;
  expected: unknown;
}>;

const ANSWER_PROBE: Probe = {
  prompt: 'Do not run any command or tool. Reply with answer "ok" and count 3.',
  schema: z.object({ answer: z.string(), count: z.number() }),
  jsonSchema: {
    type: 'object',
    properties: { answer: { type: 'string' }, count: { type: 'number' } },
    required: ['answer', 'count'],
    additionalProperties: false,
  },
  schemaName: 'typed_output_probe',
  expected: { answer: 'ok', count: 3 },
};

const STALE_CONSULT_PROBE: Probe = {
  prompt:
    'Do not run any command or tool. Answer with diagnosis "x" and action "guidance", instructions "y", context null.',
  schema: StaleConsultAnswerSchema,
  jsonSchema: STALE_CONSULT_ANSWER_JSON_SCHEMA,
  schemaName: 'stale_consult_answer',
  expected: { answer: { diagnosis: 'x', action: 'guidance', instructions: 'y', context: null } },
};

const TOOLS = [
  {
    label: 'claude-code',
    tool: 'claude-code',
    command: 'claude',
    model: undefined,
    transport: 'native',
    probe: ANSWER_PROBE,
  },
  {
    label: 'claude-code-stale-consult',
    tool: 'claude-code',
    command: 'claude',
    model: undefined,
    transport: 'native',
    probe: STALE_CONSULT_PROBE,
  },
  {
    label: 'codex',
    tool: 'codex',
    command: 'codex',
    model: undefined,
    transport: 'native',
    probe: ANSWER_PROBE,
  },
  {
    label: 'antigravity',
    tool: 'antigravity',
    command: 'agy',
    model: undefined,
    transport: 'native',
    probe: ANSWER_PROBE,
  },
  {
    label: 'opencode',
    tool: 'opencode',
    command: 'opencode',
    model: 'deepseek/deepseek-flash',
    transport: 'fallback',
    probe: ANSWER_PROBE,
  },
] as const;

const FIXTURE_DIR = join(import.meta.dirname, '../../../../testing/fixtures/typed-output');

function firstSemver(output: string): string {
  const match = output.match(/\d+\.\d+\.\d+/);
  if (match === null) throw new Error(`no semver in version output: ${output.trim()}`);
  return match[0];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe('live typed-output probe', () => {
  for (const { label, tool, command, model, transport, probe } of TOOLS) {
    itLive(
      `records one ${label} call that answers a schema through requestTyped`,
      async (ctx) => {
        const blocker = await liveToolBlocker(tool);
        if (blocker !== null) return ctx.skip(blocker);

        const version = firstSemver(execFileSync(command, ['--version'], { encoding: 'utf-8' }));

        const tmpDir = createTempDir(`live-typed-output-${label}`);
        const projectDir = join(tmpDir, 'project');
        const binDir = join(tmpDir, 'bin');
        const recordingFile = join(tmpDir, `${label}-${version}.jsonl`);
        mkdirSync(projectDir, { recursive: true });
        mkdirSync(binDir, { recursive: true });
        createTestGitRepo(projectDir);

        const resolved = await resolveCliExecutable({ command, projectDir });
        const realBinary = realpathSync(resolved.path);
        const wrapperPath = join(binDir, command);
        writeFileSync(
          wrapperPath,
          [
            '#!/bin/bash',
            `${shellQuote(realBinary)} "$@" | tee -a ${shellQuote(recordingFile)}`,
            // biome-ignore lint/suspicious/noTemplateCurlyInString: the wrapper must carry a literal shell ${PIPESTATUS[0]}
            'exit ${PIPESTATUS[0]}',
            '',
          ].join('\n'),
          'utf8',
        );
        chmodSync(wrapperPath, 0o755);

        const restorePath = prependPath(binDir);
        try {
          const gate = { ...trustedShimGate({ dir: binDir, tool }), installedVersion: version };
          const planner =
            tool === 'claude-code'
              ? createClaudeCodePlanner({ authChannel: undefined, trustedCli: gate })
              : createCliPlanner({
                  config: makeConfig({
                    planner: { kind: 'cli', tool, model },
                    implementer: { service: 'ollama', offering: 'local' },
                  }),
                  trustedCli: gate,
                });

          const call = planner.typedCall({
            projectDir,
            callbacks: { onOutput: () => {} },
            seat: 'reviewer',
          });
          const sentSchema: boolean[] = [];
          const result = await requestTyped({
            prompt: probe.prompt,
            schema: probe.schema,
            jsonSchema: probe.jsonSchema,
            schemaName: probe.schemaName,
            call: {
              ...call,
              invoke: (input) => {
                sentSchema.push(input.schema !== undefined);
                return call.invoke(input);
              },
            },
          });
          expect(sentSchema[0]).toBe(transport === 'native');
          if (!('value' in result)) throw new Error(JSON.stringify(result.error));
          expect(result.value).toEqual(probe.expected);

          const recorded = readFileSync(recordingFile, 'utf8');
          expect(recorded.trim().length).toBeGreaterThan(0);

          // A `system` record (Claude's hooks, init and status) carries the recording machine's
          // hooks, plugins, MCP servers and home paths, and no replay reads it, so a fixture keeps
          // every other record with the temporary project path normalized.
          if (process.env.SPLITBRIEF_E2E_RECORD === '1') {
            const realProjectDir = realpathSync(projectDir);
            const lines = recorded
              .split('\n')
              .filter((line) => line.trim().length > 0)
              .map((line): unknown => JSON.parse(line))
              .filter((record) => !isRecord(record) || record.type !== 'system')
              .map((record) =>
                JSON.stringify(redactPublicPayload({ payload: record }).payload).replaceAll(
                  realProjectDir,
                  '<project>',
                ),
              );
            mkdirSync(FIXTURE_DIR, { recursive: true });
            writeFileSync(
              join(FIXTURE_DIR, `${label}-${version}.jsonl`),
              `${lines.join('\n')}\n`,
              'utf8',
            );
          }
        } finally {
          restorePath();
          cleanupTempDir(tmpDir);
        }
      },
      300_000,
    );
  }
});
