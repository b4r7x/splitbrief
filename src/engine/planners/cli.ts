import { basename, join, relative, resolve } from 'node:path';
import { confinedExists, confinedReadFile } from '../../lib/confined-fs.js';
import { isPathConfined, pathConfinementError } from '../../lib/path-confinement.js';
import { matches } from '../../utils/error.js';

const isPathEscape = matches('path-confined-escape');
import type { Config } from '../../core/schemas/config.js';
import type { InvokeResult } from '../runners/types.js';
import type { Planner, PlannerCallbacks } from './types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../availability.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { getLineParser } from '../streaming/output-parsers.js';
import { CLI_TOOLS } from '../runners/cli-tools.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { assertPlannerKind } from '../config-assertions.js';
import { createSessionResumeState, runWithResumeFallback } from '../session-expiry.js';
import { runnerConfigError } from '../runners/errors.js';
import { readSpecFile } from '../../core/paths-io.js';
import { escapeRegExp } from '../../utils/regexp.js';
import {
  capturePlanningMutationBaseline,
  findUnexpectedPlanningMutations,
  planningMutationError,
} from '../orchestrator/planning/mutation-guard.js';
import { composeAbortSignal } from '../../utils/abort.js';

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

export function createCliPlanner(config: Config, initialSessionId?: string | null): Planner {
  const plannerCfg = assertPlannerKind(config, 'cli');
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
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onSessionId'>;
    mode: 'plan' | 'escalate';
    resumeId: string | null;
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<InvokeResult> {
    const { prompt, projectDir, callbacks, mode, resumeId, signal, sandboxEnv } = opts;
    let stderrOutput = '';
    const buildOpts: Parameters<typeof planner.buildArgs>[0] = {
      prompt,
      projectDir,
      mode,
      ...(resolvedModel !== undefined && { model: resolvedModel }),
      ...(supportsSessionResume && resumeId ? { sessionId: resumeId } : {}),
      ...(supportsEffort && effort !== undefined ? { effort } : {}),
    };

    const effectiveSignal = composeAbortSignal(signal, timeout);

    const result = await spawnAndCollect({
      command: tool.command,
      args: [...planner.buildArgs(buildOpts), ...extraArgs],
      cwd: projectDir,
      env: sandboxEnv,
      notFoundMessage: tool.notFoundMessage,
      parseLine,
      onText: callbacks.onOutput,
      onStderr: planner.postProcess
        ? (chunk) => {
            stderrOutput += chunk;
          }
        : undefined,
      signal: effectiveSignal,
      ...(supportsSessionResume && {
        onSessionId: (id: string) => {
          session.capture(id);
          callbacks.onSessionId?.(id);
        },
      }),
    });

    if (planner.postProcess) return planner.postProcess(result.text, stderrOutput, result.usage);
    return { text: result.text, usage: result.usage };
  }

  async function invoke(opts: {
    prompt: string;
    projectDir: string;
    callbacks: Pick<
      PlannerCallbacks,
      'onOutput' | 'onSessionId' | 'onSessionExpired' | 'sessionId'
    >;
    mode: 'plan' | 'escalate';
    signal?: AbortSignal | undefined;
    sandboxEnv?: NodeJS.ProcessEnv | undefined;
  }): Promise<InvokeResult> {
    const { prompt, projectDir, callbacks, mode, signal, sandboxEnv } = opts;
    const planningBaseline =
      mode === 'plan' && callbacks.sessionId
        ? await capturePlanningMutationBaseline(projectDir)
        : null;

    const finish = async (result: InvokeResult): Promise<InvokeResult> => {
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
        await runOnce({ prompt, projectDir, callbacks, mode, resumeId: null, signal, sandboxEnv }),
      );
    }

    const priorId = session.getResumeId();
    return finish(
      await runWithResumeFallback(
        session,
        (resumeId) =>
          runOnce({
            prompt,
            projectDir,
            callbacks,
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
    invokePlan: ({ prompt, projectDir, callbacks, signal }) =>
      invoke({ prompt, projectDir, callbacks, mode: 'plan', signal }),
    invokeEscalate: ({ prompt, projectDir, callbacks, signal, sandboxEnv }) =>
      invoke({ prompt, projectDir, callbacks, mode: 'escalate', signal, sandboxEnv }),
    hintSuccessMode: 'files',
    readPhaseOutput: readCliPhaseOutput,

    ...createCommandAvailability(tool.command, planner.isAvailableOpts),

    capabilities: { ...ONE_SHOT_API_CAPS, supportsSessionResume, supportsEffort },
  });
}
