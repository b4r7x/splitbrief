import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { readFileSafe } from '../../lib/fs.js';
import type { Config } from '../../core/schemas/config.js';
import type { InvokeResult } from '../runners/types.js';
import type { Planner, PlannerCallbacks } from './types.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createPlannerBase } from './base.js';
import { createCommandAvailability } from '../../lib/availability.js';
import { spawnAndCollect } from '../streaming/spawn-collect.js';
import { CLI_TOOLS } from '../cli-tools.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import { assertPlannerKind } from '../config-assertions.js';
import { createSessionResumeState, runWithResumeFallback } from '../session-expiry.js';
import { runnerConfigError } from '../runners/errors.js';
import { readSpecFile } from '../../core/paths-io.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInsideProject(projectDir: string, candidate: string): boolean {
  const root = resolve(projectDir);
  const resolved = resolve(candidate);
  const rel = relative(root, resolved);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function readArtifactPath(projectDir: string, filename: string, candidate: string): string | null {
  if (basename(candidate) !== filename) return null;
  if (!isInsideProject(projectDir, candidate)) return null;
  return readFileSafe(candidate);
}

function extractMarkdownLinkedArtifact(resultText: string, filename: string): string | null {
  const linkedPath = resultText.match(new RegExp(`\\[${escapeRegExp(filename)}\\]\\(([^)]+)\\)`))?.[1];
  return linkedPath ?? null;
}

function mentionsWrittenArtifact(resultText: string, filename: string): boolean {
  return new RegExp(`\\b(?:wrote|written|saved|created|updated)\\b[\\s\\S]{0,80}\\b${escapeRegExp(filename)}\\b`, 'i')
    .test(resultText);
}

function readCliPhaseOutput(filename: string, resultText: string, projectDir: string, sessionId?: string): string {
  const sessionArtifact = sessionId ? readSpecFile(projectDir, sessionId, filename) : null;
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

  async function runOnce(
    prompt: string,
    projectDir: string,
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onSessionId'>,
    mode: 'plan' | 'escalate',
    resumeId: string | null,
  ): Promise<InvokeResult> {
    let stderrOutput = '';
    const buildOpts: Parameters<typeof planner.buildArgs>[0] = {
      prompt,
      projectDir,
      mode,
      ...(resolvedModel !== undefined && { model: resolvedModel }),
      ...(supportsSessionResume && resumeId ? { sessionId: resumeId } : {}),
      ...(supportsEffort && effort !== undefined ? { effort } : {}),
    };

    const result = await spawnAndCollect({
      command: tool.command,
      args: planner.buildArgs(buildOpts),
      cwd: projectDir,
      notFoundMessage: tool.notFoundMessage,
      parseLine: planner.parseLine,
      onText: callbacks.onOutput,
      onStderr: planner.postProcess ? (chunk) => { stderrOutput += chunk; } : undefined,
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

  async function invoke(
    prompt: string,
    projectDir: string,
    callbacks: Pick<PlannerCallbacks, 'onOutput' | 'onSessionId' | 'onSessionExpired'>,
    mode: 'plan' | 'escalate',
  ): Promise<InvokeResult> {
    if (!supportsSessionResume) {
      return runOnce(prompt, projectDir, callbacks, mode, null);
    }

    const priorId = session.getResumeId();
    return runWithResumeFallback(
      session,
      (resumeId) => runOnce(prompt, projectDir, callbacks, mode, resumeId ?? null),
      () => { if (priorId) callbacks.onSessionExpired?.(priorId); },
    );
  }

  return createPlannerBase({
    invokePlan: ({ prompt, projectDir, callbacks }) => invoke(prompt, projectDir, callbacks, 'plan'),
    invokeEscalate: ({ prompt, projectDir, callbacks }) => invoke(prompt, projectDir, callbacks, 'escalate'),
    hintSuccessMode: 'files',
    readPhaseOutput: readCliPhaseOutput,

    ...createCommandAvailability(tool.command, planner.isAvailableOpts),

    capabilities: { ...ONE_SHOT_API_CAPS, supportsSessionResume, supportsEffort },
  });
}
