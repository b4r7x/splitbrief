import { configStore } from '../stores/config.js';
import { sessionsStore } from '../stores/sessions.js';
import { skillsStore } from '../stores/skills.js';
import { detectionStore } from '../stores/detection.js';
import { setHighlightTheme } from '../utils/highlight.js';
import { getPlannerToolName } from '../core/config/planner-config.js';
import { discoverSkills, detectAvailablePlanners, detectAvailableImplementers } from '../engine/index.js';
import type { WorkflowOpts } from '../types.js';
import { cliError } from './errors.js';

export interface InitStoresOverrides extends WorkflowOpts {
  contextLength?: number | undefined;
}

export async function initStores(projectDir: string, opts: InitStoresOverrides = {}): Promise<void> {
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
    contextLength: opts.contextLength,
    autoApprove: opts.auto,
    mode: opts.mode,
  });
  const storeConfig = configStore.get().config;
  if (!storeConfig) throw cliError('configStore.load did not populate config');
  if (storeConfig.shikiTheme) setHighlightTheme(storeConfig.shikiTheme);
  sessionsStore.load(storeConfig.sessions?.scope ?? 'project', projectDir);
  await skillsStore.discover(discoverSkills, getPlannerToolName(storeConfig.planner), projectDir);
  await detectionStore.load(detectAvailablePlanners, detectAvailableImplementers, projectDir);
}
