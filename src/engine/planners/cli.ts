import { readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { confinedExists, confinedReadFile } from '../../lib/confined-fs.js';
import { isPathConfined, pathConfinementError } from '../../lib/path-confinement.js';
import { matches } from '../../utils/error.js';

const isPathEscape = matches('path-confined-escape');
import type { Config } from '../../core/schemas/config.js';
import type { CliExecutableIdentity } from '../../core/discovery/detection.js';
import type { Planner, PlannerCallbacks, PlannerFactoryOptions } from './types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../availability.js';
import {
  CLI_NO_DEADLINE_MS,
  invokeCliAdapter,
  toCliEnvironment,
} from '../runners/invoke-cli-adapter.js';
import { CLI_PROMPT_SENTINEL } from '../runners/cli-tools/candidate-contract.js';
import { withOutputFormat } from '../runners/cli-tools/output-format.js';
import { lookupCliPlannerAdapter } from '../runners/cli-tools/registry.js';
import type { CliPlannerAdapter } from '../runners/cli-tools/contract.js';
import { resolveCliModel } from '../../core/providers/automatic-model.js';
import { assertPlannerKind } from '../config-assertions.js';
import {
  createSessionAttemptCallContext,
  createSessionResumeState,
  isSessionExpiredError,
  runWithResumeFallback,
  sessionResumeExpiredError,
  sessionResumeMismatchError,
} from '../session-expiry.js';
import { readSpecFile } from '../../core/paths-io.js';
import { escapeRegExp } from '../../utils/regexp.js';
import type { ChangedFilesBaseline } from '../orchestrator/changed-files-baseline.js';
import {
  capturePlanningMutationBaseline,
  findUnexpectedPlanningMutations,
  planningMutationError,
} from '../orchestrator/planning/mutation-guard.js';
import { sha256Hex } from '../../utils/sha256.js';
import { composeAbortSignal } from '../../utils/abort.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { createRunnerAttemptCallbackBuffer } from '../calls/callback-buffer.js';
import { resolveCliExecutableAliases } from '../runners/resolve-cli-executable.js';
import { assertCliStartGate, type CliStartGate } from '../runners/start-gate.js';
import { processError } from '../../lib/process/errors.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';
import { createQuestionAccumulator } from '../parsers/question.js';
const isCliExecutableUnavailable = matches('cli-executable-unavailable');

function cliNotFoundMessage(descriptor: CliPlannerAdapter['descriptor']): string {
  return `${descriptor.displayName} not found. See ${descriptor.compatibility.installUrl}`;
}

function readArtifactPath(projectDir: string, filename: string, candidate: string): string | null {
  if (basename(candidate) !== filename) return null;
  const relativePath = relative(projectDir, resolve(projectDir, candidate));
  if (!isPathConfined(relativePath, projectDir)) return null;
  try {
    if (!confinedExists(projectDir, relativePath)) return null;
    return confinedReadFile(projectDir, relativePath);
  } catch (err) {
    if (pathConfinementError.isSymlinkRead(err) || isPathEscape(err)) return null;
    return null;
  }
}

function extractMarkdownLinkedArtifact(resultText: string, filename: string): string | null {
  const linkedPath = resultText.match(
    new RegExp(`\\[${escapeRegExp(filename)}\\]\\(([^)]+)\\)`),
  )?.[1];
  return linkedPath ?? null;
}

function mentionsWrittenArtifact(resultText: string, filename: string): boolean {
  return new RegExp(
    `\\b(?:wrote|written|saved|created|updated)\\b[\\s\\S]{0,80}\\b${escapeRegExp(filename)}\\b`,
    'i',
  ).test(resultText);
}

function extractInlineArtifactPaths(resultText: string, filename: string): string[] {
  const mentions = resultText.match(
    new RegExp(`[^\\s\`'"()\\[\\]]*${escapeRegExp(filename)}`, 'g'),
  );
  return [...new Set(mentions ?? [])].slice(0, 5);
}

let activePhaseMutationBaseline: ChangedFilesBaseline | null = null;

function toConfinedRelativePath(projectDir: string, candidate: string): string | null {
  const relativePath = relative(projectDir, resolve(projectDir, candidate));
  if (!isPathConfined(relativePath, projectDir)) return null;
  return relativePath;
}

function wasPathMutatedDuringPhase(
  projectDir: string,
  candidate: string,
  baseline: ChangedFilesBaseline,
): boolean {
  const relativePath = toConfinedRelativePath(projectDir, candidate);
  if (relativePath === null) return false;
  const prior = baseline.fingerprints.get(relativePath);
  if (prior === undefined) return true;
  try {
    const current = sha256Hex(readFileSync(resolve(projectDir, relativePath), 'utf-8'));
    return current !== prior;
  } catch {
    return prior !== 'missing';
  }
}

function acceptInlineArtifactPath(
  projectDir: string,
  candidate: string,
  baseline: ChangedFilesBaseline | null,
): boolean {
  if (baseline === null) return true;
  return wasPathMutatedDuringPhase(projectDir, candidate, baseline);
}

export function readCliPhaseOutput(
  filename: string,
  resultText: string,
  projectDir: string,
  sessionId?: string,
  mutationBaseline?: ChangedFilesBaseline | null,
): string {
  const sessionArtifact = sessionId ? readSpecFile({ projectDir, sessionId }, filename) : null;
  if (sessionArtifact !== null) return sessionArtifact;

  const linkedPath = extractMarkdownLinkedArtifact(resultText, filename);
  if (linkedPath) {
    const linkedArtifact = readArtifactPath(projectDir, filename, linkedPath);
    if (linkedArtifact !== null) return linkedArtifact;
  }

  if (mentionsWrittenArtifact(resultText, filename)) {
    const baseline =
      mutationBaseline !== undefined ? mutationBaseline : activePhaseMutationBaseline;
    const rootArtifact = readArtifactPath(projectDir, filename, join(projectDir, filename));
    if (rootArtifact !== null) return rootArtifact;

    for (const candidate of extractInlineArtifactPaths(resultText, filename)) {
      if (!acceptInlineArtifactPath(projectDir, candidate, baseline)) continue;
      const artifact = readArtifactPath(projectDir, filename, candidate);
      if (artifact !== null) return artifact;
    }
  }

  return resultText;
}

function isRecoverableResumeNoise(event: RunnerCallEvent, resumeId: string): boolean {
  switch (event.type) {
    case 'call_stderr_delta':
      return isSessionExpiredError(event.text);
    case 'call_session_id':
      return event.nativeSessionId !== resumeId;
    default:
      return false;
  }
}

export function createCliPlanner(
  config: Config,
  initialSessionId?: string | null,
  options?: PlannerFactoryOptions,
): Planner {
  const plannerCfg = assertPlannerKind(config, 'cli');
  resolveCliRunnerAuth(plannerCfg);
  const trustedCli: CliStartGate | undefined = options?.trustedCli;
  const resolvedModel = resolveCliModel(plannerCfg.model, plannerCfg.tool);
  const baseAdapter = lookupCliPlannerAdapter(plannerCfg.tool);
  const adapter = plannerCfg.outputFormat
    ? withOutputFormat(baseAdapter, plannerCfg.outputFormat)
    : baseAdapter;
  const command = adapter.descriptor.command;
  const notFoundMessage = cliNotFoundMessage(adapter.descriptor);
  const { supportsSessionResume, supportsEffort } = adapter;

  const session = createSessionResumeState();
  if (supportsSessionResume) session.capture(initialSessionId ?? null);
  const effort = plannerCfg.effort;
  const timeout = plannerCfg.timeout;
  const extraArgs = plannerCfg.args ?? [];

  async function resolveExecutable(projectDir: string): Promise<CliExecutableIdentity> {
    try {
      return (
        await resolveCliExecutableAliases({
          commands: adapter.descriptor.executableAliases,
          projectDir,
          trust: assertCliStartGate(plannerCfg.tool, trustedCli),
        })
      ).executable;
    } catch (err) {
      if (isCliExecutableUnavailable(err)) {
        throw processError.notFound(command, notFoundMessage);
      }
      throw err;
    }
  }

  async function runOnce(opts: {
    prompt: string;
    projectDir: string;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onQuestion' | 'onSessionId' | 'onCallEvent'>;
    callContext: RunnerCallContext;
    mode: 'plan' | 'escalate';
    resumeId: string | null;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<RunnerCallResult> {
    const { prompt, projectDir, callbacks, callContext, mode, resumeId, signal, sandboxEnv } = opts;
    let unexpectedResumeSessionId: string | null = null;
    let stderrOutput = '';
    const callbackBuffer = resumeId === null ? null : createRunnerAttemptCallbackBuffer(callbacks);
    const attemptCallbacks = callbackBuffer?.callbacks ?? callbacks;
    const questionAccumulator = callbacks.onQuestion ? createQuestionAccumulator() : null;
    const onOutput = (text: string): void => {
      attemptCallbacks.onOutput(text);
      if (questionAccumulator === null) return;
      const newQuestions = questionAccumulator.addChunk(text);
      if (newQuestions.length > 0) attemptCallbacks.onQuestion?.(newQuestions);
    };

    const effectiveSignal = composeAbortSignal(signal, timeout);
    const onCallEvent = (event: RunnerCallEvent): void => {
      if (event.type === 'call_stderr_delta') {
        stderrOutput = `${stderrOutput}${event.text}`.slice(-8_192);
      }
      if (resumeId && isRecoverableResumeNoise(event, resumeId)) return;
      attemptCallbacks.onCallEvent?.(event);
    };

    try {
      const executable = await resolveExecutable(projectDir);
      const baseArgs = adapter.baseArgs({
        prompt: CLI_PROMPT_SENTINEL,
        model: resolvedModel,
        projectDir,
        configuredArgs: extraArgs,
        mode,
        sessionId: supportsSessionResume ? resumeId : null,
        effort: supportsEffort ? effort : undefined,
      });
      const result = await invokeCliAdapter({
        adapter,
        invocation: {
          executable,
          args: [...baseArgs, ...extraArgs],
          baseArgs,
          promptTransport: adapter.promptTransport,
          environment: toCliEnvironment(
            sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, plannerCfg, 'planner')),
          ),
          cwd: projectDir,
          timeoutMs: timeout ?? CLI_NO_DEADLINE_MS,
          signal: effectiveSignal,
        },
        prompt,
        callContext,
        onOutput,
        onCallEvent,
        onSessionId:
          supportsSessionResume && mode === 'plan'
            ? (id: string) => {
                if (resumeId && id !== resumeId) {
                  unexpectedResumeSessionId = id;
                  return;
                }
                session.capture(id);
                attemptCallbacks.onSessionId?.(id);
              }
            : undefined,
        idle: {
          warnMs: plannerCfg.idleWarnMs,
          killMs: plannerCfg.idleKillMs,
        },
      });

      const returnedSessionId = result.nativeSessionId ?? unexpectedResumeSessionId;
      if (resumeId && returnedSessionId !== null && returnedSessionId !== resumeId) {
        throw sessionResumeMismatchError(resumeId, returnedSessionId);
      }

      if (result.status !== 'completed') {
        const failureText = `${result.error?.message ?? result.text}\n${stderrOutput}`;
        if (resumeId && isSessionExpiredError(failureText)) {
          throw sessionResumeExpiredError(resumeId, failureText);
        }
        callbackBuffer?.flush();
        return result;
      }
      callbackBuffer?.flush();
      return result;
    } catch (err) {
      if (!resumeId || !isSessionExpiredError(err)) callbackBuffer?.flush();
      throw err;
    }
  }

  async function invoke(opts: {
    prompt: string;
    projectDir: string;
    callbacks: Pick<
      PlannerCallbacks,
      'onOutput' | 'onQuestion' | 'onSessionId' | 'onSessionExpired' | 'sessionId' | 'onCallEvent'
    >;
    callContext: RunnerCallContext;
    accessMode: 'planning' | 'read-only' | 'write-files';
    artifactFile?: string | undefined;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<RunnerCallResult> {
    const {
      prompt,
      projectDir,
      callbacks,
      callContext,
      accessMode,
      artifactFile,
      signal,
      sandboxEnv,
    } = opts;
    const shouldGuardMutations =
      accessMode === 'read-only' ||
      (accessMode === 'planning' && callbacks.sessionId !== undefined);
    if (shouldGuardMutations) await resolveExecutable(projectDir);
    const environment =
      sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, plannerCfg, 'planner'));
    const mutationBaseline = shouldGuardMutations
      ? await capturePlanningMutationBaseline(projectDir)
      : null;
    activePhaseMutationBaseline = mutationBaseline;
    const adapterMode = accessMode === 'write-files' ? 'escalate' : 'plan';

    const finish = async (result: RunnerCallResult): Promise<RunnerCallResult> => {
      if (mutationBaseline !== null) {
        const unexpected = await findUnexpectedPlanningMutations({
          projectDir,
          sessionId: callbacks.sessionId ?? '',
          baseline: mutationBaseline,
          artifactFile,
          internalStatePaths: adapter.descriptor.internalStatePaths,
        });
        if (unexpected.length > 0) {
          throw planningMutationError.unexpectedMutations(unexpected);
        }
      }
      return result;
    };

    if (!supportsSessionResume) {
      return finish(
        await runOnce({
          prompt,
          projectDir,
          callbacks,
          callContext,
          mode: adapterMode,
          resumeId: null,
          signal,
          sandboxEnv: environment,
        }),
      );
    }

    if (accessMode === 'write-files') {
      return finish(
        await runOnce({
          prompt,
          projectDir,
          callbacks,
          callContext,
          mode: adapterMode,
          resumeId: null,
          signal,
          sandboxEnv: environment,
        }),
      );
    }

    const priorId = session.getResumeId();
    return finish(
      await runWithResumeFallback(
        session,
        (resumeId, attempt) =>
          runOnce({
            prompt,
            projectDir,
            callbacks,
            callContext: createSessionAttemptCallContext(callContext, attempt),
            mode: adapterMode,
            resumeId: resumeId ?? null,
            signal,
            sandboxEnv: environment,
          }),
        () => {
          if (priorId) callbacks.onSessionExpired?.(priorId);
        },
      ),
    );
  }

  return createPlannerBase({
    invokePlan: ({ prompt, projectDir, callbacks, callContext, artifactFile, signal }) =>
      invoke({
        prompt,
        projectDir,
        callbacks,
        callContext,
        accessMode: 'planning',
        artifactFile,
        signal,
      }),
    invokeEscalate: ({
      prompt,
      projectDir,
      callbacks,
      callContext,
      accessMode,
      signal,
      sandboxEnv,
    }) => invoke({ prompt, projectDir, callbacks, callContext, accessMode, signal, sandboxEnv }),
    runnerName: plannerCfg.tool,
    ...(resolvedModel !== undefined && { model: resolvedModel }),
    hintSuccessMode: 'text',
    escalateFullMode: 'files',
    readPhaseOutput: readCliPhaseOutput,

    ...createCommandAvailability(baseAdapter.descriptor.executableAliases, {
      timeout: baseAdapter.probe.version.timeoutMs,
    }),

    capabilities: { ...ONE_SHOT_API_CAPS, supportsSessionResume, supportsEffort },
  });
}
