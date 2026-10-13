import { randomBytes } from 'node:crypto';
import { readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliExecutableIdentity } from '../../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG } from '../../../core/runners/cli-tool-catalog.js';
import type { ImplementerCliToolId } from '../../../core/schemas/enums.js';
import { ImplementerConfigSchema } from '../../../core/schemas/implementer-config.js';
import { createRunnerCallId } from '../../calls/call-id.js';
import type { RunnerCallResult } from '../../calls/types.js';
import { sanitizeCandidateOutput } from '../../providers/candidate-contract.js';
import { invokeCliAdapter, toCliEnvironment } from '../invoke-cli-adapter.js';
import { resolveCliExecutableAliases } from '../resolve-cli-executable.js';
import { createRunnerSandboxEnv } from '../sandbox-env.js';
import { clearBridgedCliState } from '../sandbox-state-bridge.js';
import { CLI_PROJECT_DIR_SENTINEL, CLI_PROMPT_SENTINEL } from './candidate-contract.js';
import {
  CLI_CONFORMANCE_EXIT_CODES,
  createProject,
  safeReason,
  writeEvidenceFile,
  type CliConformanceOutcome,
} from './contract-harness.js';
import { probeCliReadiness } from './readiness-probe.js';
import { lookupCliImplementerAdapter } from './registry.js';

const CWD_TIMEOUT_MS = 180_000;
const MAX_REPLY_BYTES = 2_048;

export type CwdCliConformanceOptions = Readonly<{
  tool: ImplementerCliToolId;
  recordPath: string;
  model?: string | undefined;
  timeoutMs?: number | undefined;
}>;

type CwdObservation = Readonly<{
  shellCwd: string | null;
  landedAt: readonly string[];
}>;

/**
 * Deliberately neutral about where to work: a model that is not told its
 * workspace picks one, and that choice is the fact under test. Measured on
 * agy 1.2.9 without `--add-dir`: this prompt ran the shell in
 * `~/.gemini/antigravity-cli/scratch`.
 */
export function cwdProbePrompt(file: string): string {
  return [
    `Create a file named ${file} that contains the output of the shell command pwd,`,
    `for example by running: pwd > ${file}. Do nothing else.`,
    'Reply with only the absolute path of the file you created.',
  ].join(' ');
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Where an escaped write shows up: the host home and the tool scratch
 * directory seen in the field, the child's own HOME and TMPDIR, the harness's
 * cwd, and any absolute directory the model names in its reply.
 */
function outsideCandidates(env: NodeJS.ProcessEnv, reply: string, file: string): string[] {
  const named = (reply.match(/\/[^\s`'"]*[^\s`'".,;:)]/g) ?? []).map((path) =>
    path.endsWith(`/${file}`) ? dirname(path) : path,
  );
  return [
    homedir(),
    join(homedir(), '.gemini', 'antigravity-cli', 'scratch'),
    env.HOME,
    env.TMPDIR,
    process.cwd(),
    ...named,
  ].filter((dir): dir is string => dir !== undefined);
}

async function observe(opts: {
  projectDir: string;
  file: string;
  env: NodeJS.ProcessEnv;
  reply: string;
}): Promise<CwdObservation> {
  const inside = join(opts.projectDir, opts.file);
  const landedAt: string[] = [];
  let shellCwd: string | null = null;
  const insideContent = await readIfPresent(inside);
  if (insideContent !== null) {
    landedAt.push(inside);
    shellCwd = insideContent.trim();
  }
  const seen = new Set([inside]);
  for (const dir of outsideCandidates(opts.env, opts.reply, opts.file)) {
    const path = join(await canonical(dir), opts.file);
    if (seen.has(path)) continue;
    seen.add(path);
    const content = await readIfPresent(path);
    if (content === null) continue;
    landedAt.push(path);
    shellCwd ??= content.trim();
    await rm(path, { force: true });
  }
  return { shellCwd, landedAt };
}

function verdictReason(opts: {
  result: RunnerCallResult;
  projectDir: string;
  file: string;
  observation: CwdObservation;
  shellCwdCanonical: string | null;
}): string | undefined {
  const { result, projectDir, file, observation } = opts;
  const inside = join(projectDir, file);
  const outside = observation.landedAt.filter((path) => path !== inside);
  if (outside.length > 0) return `wrote ${file} outside the staged project: ${outside.join(', ')}`;
  if (!observation.landedAt.includes(inside)) {
    return result.status === 'completed'
      ? `wrote no ${file} in the staged project`
      : `the CLI call ended ${result.status}: ${result.error?.message ?? 'no detail'}`;
  }
  if (opts.shellCwdCanonical !== projectDir) {
    return `shell ran in ${observation.shellCwd ?? 'an unknown directory'}, not the staged project`;
  }
  return undefined;
}

/**
 * Proves an admitted implementer tool works where SPLITBRIEF puts it: the
 * production adapter argv and sandbox environment, spawned in a throwaway git
 * project, must run its shell there and land a relative write there. A write
 * found anywhere else is removed, recorded, and fails the tool. This spends
 * one small model call.
 */
export async function runCwdCliConformance(
  options: CwdCliConformanceOptions,
): Promise<CliConformanceOutcome> {
  const file = `hello-${randomBytes(4).toString('hex')}.txt`;
  const project = await createProject(undefined);
  const projectDir = await realpath(project.path);
  const redact = (value: string) => value.replaceAll(projectDir, CLI_PROJECT_DIR_SENTINEL);
  const finish = async (
    exitCode: CliConformanceOutcome['exitCode'],
    reason: string | undefined,
    evidence: Readonly<Record<string, unknown>> = {},
  ): Promise<CliConformanceOutcome> => {
    const verdict = exitCode === CLI_CONFORMANCE_EXIT_CODES.PASS ? 'PASS' : 'OMIT';
    await writeEvidenceFile(
      options.recordPath,
      JSON.stringify(
        {
          candidateId: options.tool,
          role: 'implementer',
          verdict,
          ...(reason !== undefined && { reason: redact(reason) }),
          ...evidence,
        },
        null,
        2,
      ),
    );
    return {
      exitCode,
      verdict,
      candidateId: options.tool,
      role: 'implementer',
      ...(reason !== undefined && { reason }),
    };
  };
  try {
    const adapter = lookupCliImplementerAdapter(options.tool);
    const config = ImplementerConfigSchema.parse({ kind: 'cli', tool: options.tool });
    const env = await createRunnerSandboxEnv(projectDir, config, 'implementer');
    let executable: CliExecutableIdentity;
    try {
      executable = (
        await resolveCliExecutableAliases({
          commands: CLI_TOOL_CATALOG[options.tool].executableAliases,
          projectDir,
        })
      ).executable;
    } catch (cause) {
      return await finish(CLI_CONFORMANCE_EXIT_CODES.OMIT, safeReason(cause));
    }
    const readiness = await probeCliReadiness({
      tool: options.tool,
      executable,
      probe: adapter.probe,
    });
    const installedVersion = readiness.installedVersion ?? undefined;
    const baseArgs = adapter.baseArgs({
      prompt: CLI_PROMPT_SENTINEL,
      model: options.model,
      projectDir,
      configuredArgs: [],
      installedVersion,
    });
    const invocation = {
      installedVersion: installedVersion ?? null,
      argv: baseArgs.map(redact),
    };
    let result: RunnerCallResult;
    try {
      result = await invokeCliAdapter({
        adapter,
        invocation: {
          executable,
          args: baseArgs,
          baseArgs,
          promptTransport: adapter.promptTransport,
          environment: toCliEnvironment(env),
          cwd: projectDir,
          timeoutMs: options.timeoutMs ?? CWD_TIMEOUT_MS,
          signal: undefined,
        },
        prompt: cwdProbePrompt(file),
        callContext: {
          callId: createRunnerCallId(`cli-cwd-conformance-${options.tool}`),
          role: 'implementer',
          backendKind: 'cli',
          runnerName: options.tool,
        },
      });
    } catch (cause) {
      return await finish(
        CLI_CONFORMANCE_EXIT_CODES.HARNESS_FAILURE,
        safeReason(cause),
        invocation,
      );
    }
    const observation = await observe({ projectDir, file, env, reply: result.text });
    const shellCwdCanonical =
      observation.shellCwd === null ? null : await canonical(observation.shellCwd);
    const reason = verdictReason({ result, projectDir, file, observation, shellCwdCanonical });
    return await finish(
      reason === undefined ? CLI_CONFORMANCE_EXIT_CODES.PASS : CLI_CONFORMANCE_EXIT_CODES.OMIT,
      reason,
      {
        ...invocation,
        status: result.status,
        shellCwd: observation.shellCwd === null ? null : redact(observation.shellCwd),
        landedAt: observation.landedAt.map(redact),
        reply: sanitizeCandidateOutput(redact(result.text), MAX_REPLY_BYTES),
        toolUses: sanitizeCandidateOutput(
          redact(JSON.stringify(result.toolUses.map(({ name, input }) => ({ name, input })))),
          MAX_REPLY_BYTES,
        ),
      },
    );
  } finally {
    await clearBridgedCliState(project.path);
    await project.cleanup();
  }
}
