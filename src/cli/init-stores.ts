import { configStore } from '../stores/config.js';
import { sessionsStore } from '../stores/sessions.js';
import { skillsStore } from '../stores/skills.js';
import { detectionStore } from '../stores/detection.js';
import { setHighlightTheme } from '../utils/highlight.js';
import type { WorkflowOpts } from '../types.js';

export interface InitStoresOverrides extends WorkflowOpts {
  contextLength?: number | undefined;
}

export function initStores(projectDir: string, opts: InitStoresOverrides = {}): void {
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
  if (!storeConfig) throw new Error('configStore.load did not populate config');
  if (storeConfig.shikiTheme) setHighlightTheme(storeConfig.shikiTheme);
  sessionsStore.load(storeConfig.sessions?.scope ?? 'project', projectDir);
  skillsStore.discover(storeConfig.planner.tool, projectDir);
  detectionStore.load();
}
