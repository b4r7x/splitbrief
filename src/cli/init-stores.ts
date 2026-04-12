import { configStore } from '../stores/config.js';
import { sessionsStore } from '../stores/sessions.js';
import { skillsStore } from '../stores/skills.js';
import { detectionStore } from '../stores/detection.js';
import { feedbackStore } from '../stores/feedback.js';
import { setHighlightTheme } from '../utils/highlight.js';
import { warnError } from '../utils/format.js';
import { discoverSkills, detectCapabilities } from '../engine/index.js';
import type { WorkflowOpts, Config, PlannerTool } from '../types.js';
import { isPlannerToolId } from '../core/providers/catalog.js';
import { cliError } from './errors.js';

export function getPlannerToolId(config: Config['planner']): PlannerTool {
  switch (config.kind) {
    case 'cli':
      return config.tool;
    case 'api': {
      const provider = config.provider;
      return isPlannerToolId(provider) ? provider : 'anthropic';
    }
    case 'shell':
      return 'shell';
    case 'agent-sdk':
      return 'agent-sdk';
    case 'agent':
      return 'shell';
  }
}

export async function initStores(projectDir: string, opts: WorkflowOpts = {}): Promise<void> {
  configStore.load(projectDir, {
    planner: {
      tool: opts.planner,
      model: opts.plannerModel,
      command: opts.plannerCommand,
    },
    implementer: {
      tool: opts.implementer ?? opts.provider,
      model: opts.implementerModel ?? opts.model,
      command: opts.implementerCommand,
    },
    autoApprove: opts.auto,
    mode: opts.mode,
    budget: opts.budget,
  });
  const storeConfig = configStore.get().config;
  if (!storeConfig) throw cliError('configStore.load did not populate config');
  if (storeConfig.shikiTheme) setHighlightTheme(storeConfig.shikiTheme);
  sessionsStore.load(storeConfig.sessions?.scope ?? 'project', projectDir);

  let contextLength: number | undefined;
  try {
    const caps = await detectCapabilities(storeConfig);
    if (caps.contextLength) {
      contextLength = caps.contextLength;
    }
  } catch (err) {
    warnError('Could not detect provider capabilities', err);
    feedbackStore.setMessage('Provider detection failed — using defaults');
  }

  if (contextLength !== undefined) {
    configStore.setContextLength(contextLength);
  }

  await Promise.all([
    skillsStore.discover(discoverSkills, getPlannerToolId(storeConfig.planner), projectDir),
    detectionStore.load(projectDir),
  ]);
}
