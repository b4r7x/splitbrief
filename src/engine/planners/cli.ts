import { basename, join, relative, resolve } from 'node:path';
import { confinedExists, confinedReadFile } from '../../lib/confined-fs.js';
import { isPathConfined, pathConfinementError } from '../../lib/path-confinement.js';
import { matches } from '../../utils/error.js';

const isPathEscape = matches('path-confined-escape');
import type { Config } from '../../core/schemas/config.js';
import type { Planner, PlannerCallbacks, PlannerFactoryOptions } from './types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../availability.js';
import { getLineParser } from '../streaming/output-parsers.js';
import {
  CLI_NO_DEADLINE_MS,
  CLI_PROMPT_PLACEHOLDER,
  CLI_TOOLS,
  createCliPlannerAdapter,
  invokeCliAdapter,
  toCliEnvironment,
} from '../runners/cli-tools.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { assertPlannerKind } from '../config-assertions.js';
import {
  createSessionAttemptCallContext,
  createSessionResumeState,
  isSessionExpiredError,
  runWithResumeFallback,
  sessionResumeExpiredError,
  sessionResumeMismatchError,
} from '../session-expiry.js';
import { runnerConfigError } from '../runners/errors.js';
import { readSpecFile } from '../../core/paths-io.js';
import { escapeRegExp } from '../../utils/regexp.js';
import {
  capturePlanningMutationBaseline,
  findUnexpectedPlanningMutations,
  planningMutationError,
} from '../orchestrator/planning/mutation-guard.js';
import { composeAbortSignal } from '../../utils/abort.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallResult } from '../calls/types.js';
import { createRunnerAttemptCallbackBuffer } from '../calls/callback-buffer.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import { assertCliStartGate, type CliStartGate } from '../runners/start-gate.js';
import { processError } from '../../lib/process/errors.js';
import { createRunnerSandboxEnv, resolveCliRunnerAuth } from '../runners/sandbox-env.js';

const isCliExecutableUnavailable = matches('cli-executable-unavailable');

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

function readCliPhaseOutput(
  filename: string,
  resultText: string,
  projectDir: string,
  sessionId?: string,
): string {
  const sessionArtifact = sessionId ? readSpecFile({ projectDir, sessionId }, filename) : null;
  if (sessionArtifact !== null) return sessionArtifact;

  const linkedPath = extractMarkdownLinkedArtifact(resultText, filename);
  if (linkedPath) {
    const linkedArtifact = readArtifactPath(projectDir, filename, linkedPath);
    if (linkedArtifact !== null) return linkedArtifact;
  }

  if (mentionsWrittenArtifact(resultText, filename)) {
    const rootArtifact = readArtifactPath(projectDir, filename, join(projectDir, filename));
    if (rootArtifact !== null) return rootArtifact;
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
  const resolvedModel = resolveAutoModel(plannerCfg.model, plannerCfg.tool);
  const tool = CLI_TOOLS[plannerCfg.tool];
  if (!tool.planner) throw runnerConfigError.missingToolConfig(plannerCfg.tool, 'planner');
  const planner = tool.planner;
  const supportsSessionResume = planner.supportsSessionResume === true;

  const session = createSessionResumeState();
  if (supportsSessionResume) session.capture(initialSessionId ?? null);
  const effort = plannerCfg.effort;
  const supportsEffort = planner.supportsEffort === true;
  const timeout = plannerCfg.timeout;
  const extraArgs = plannerCfg.args ?? [];
  const parseLine = plannerCfg.outputFormat
    ? getLineParser(plannerCfg.outputFormat)
    : planner.parseLine;

  async function runOnce(opts: {
    prompt: string;
    projectDir: string;
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onSessionId' | 'onCallEvent'>;
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
    const buildOpts: Parameters<typeof planner.buildArgs>[0] = {
      prompt,
      projectDir,
      mode,
      ...(resolvedModel !== undefined && { model: resolvedModel }),
      ...(supportsSessionResume && resumeId ? { sessionId: resumeId } : {}),
      ...(supportsEffort && effort !== undefined ? { effort } : {}),
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
      let executable: Awaited<ReturnType<typeof resolveCliExecutable>>;
      try {
        executable = await resolveCliExecutable(
          tool.command,
          projectDir,
          assertCliStartGate(plannerCfg.tool, trustedCli),
        );
      } catch (err) {
        if (isCliExecutableUnavailable(err)) {
          throw processError.notFound(tool.command, tool.notFoundMessage);
        }
        throw err;
      }
      const adapter = createCliPlannerAdapter({
        toolName: plannerCfg.tool,
        planner,
        parseLine,
        postProcess: planner.postProcess,
      });
      const args = adapter.buildArgs({
        ...buildOpts,
        prompt: CLI_PROMPT_PLACEHOLDER,
        model: resolvedModel,
        sessionId: resumeId,
        effort: supportsEffort ? effort : undefined,
        configuredArgs: extraArgs,
      });
      const result = await invokeCliAdapter({
        adapter,
        invocation: {
          executable,
          args,
          promptTransport: adapter.promptTransport,
          environment: toCliEnvironment(
            sandboxEnv ?? (await createRunnerSandboxEnv(projectDir, plannerCfg)),
          ),
          cwd: projectDir,
          timeoutMs: timeout ?? CLI_NO_DEADLINE_MS,
          signal: effectiveSignal,
        },
        prompt,
        callContext,
        onOutput: attemptCallbacks.onOutput,
        onCallEvent,
        onSessionId: supportsSessionResume
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
      'onOutput' | 'onSessionId' | 'onSessionExpired' | 'sessionId' | 'onCallEvent'
    >;
    callContext: RunnerCallContext;
    mode: 'plan' | 'escalate';
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<RunnerCallResult> {
    const { prompt, projectDir, callbacks, callContext, mode, signal, sandboxEnv } = opts;
    const planningBaseline =
      mode === 'plan' && callbacks.sessionId
        ? await capturePlanningMutationBaseline(projectDir)
        : null;

    const finish = async (result: RunnerCallResult): Promise<RunnerCallResult> => {
      if (planningBaseline && callbacks.sessionId) {
        const unexpected = await findUnexpectedPlanningMutations({
          projectDir,
          sessionId: callbacks.sessionId,
          baseline: planningBaseline,
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
          mode,
          resumeId: null,
          signal,
          sandboxEnv,
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
            mode,
            resumeId: resumeId ?? null,
            signal,
            sandboxEnv,
          }),
        () => {
          if (priorId) callbacks.onSessionExpired?.(priorId);
        },
      ),
    );
  }

  return createPlannerBase({
    invokePlan: ({ prompt, projectDir, callbacks, callContext, signal }) =>
      invoke({ prompt, projectDir, callbacks, callContext, mode: 'plan', signal }),
    invokeEscalate: ({ prompt, projectDir, callbacks, callContext, signal, sandboxEnv }) =>
      invoke({ prompt, projectDir, callbacks, callContext, mode: 'escalate', signal, sandboxEnv }),
    runnerName: plannerCfg.tool,
    ...(resolvedModel !== undefined && { model: resolvedModel }),
    hintSuccessMode: 'files',
    readPhaseOutput: readCliPhaseOutput,

    ...createCommandAvailability(tool.command, planner.isAvailableOpts),

    capabilities: { ...ONE_SHOT_API_CAPS, supportsSessionResume, supportsEffort },
  });
}
