import { createStore, storeBase } from './create-store.js';
import { loadConfig } from '../core/config.js';
import type { Config, PlannerTool } from '../types.js';

interface ConfigOverrides {
  modelOverride?: string;
  providerOverride?: string;
  contextLengthOverride?: number;
  plannerOverride?: string;
  plannerModelOverride?: string;
  autoApprove?: boolean;
}

interface ConfigState {
  config: Config | null;
  projectDir: string;
  overrides: ConfigOverrides;
}

const empty: ConfigState = {
  config: null,
  projectDir: '',
  overrides: {},
};

const store = createStore<ConfigState>(empty);

function load(projectDir: string, overrides: ConfigOverrides = {}) {
  const cfg = loadConfig(projectDir);
  if (overrides.modelOverride !== undefined) cfg.implementer.model = overrides.modelOverride;
  if (overrides.providerOverride !== undefined) cfg.implementer.provider = overrides.providerOverride;
  if (overrides.contextLengthOverride !== undefined) cfg.implementer.contextLength = overrides.contextLengthOverride;
  if (overrides.plannerOverride !== undefined) cfg.planner.tool = overrides.plannerOverride as PlannerTool;
  if (overrides.plannerModelOverride !== undefined) cfg.planner.model = overrides.plannerModelOverride;
  if (overrides.autoApprove) {
    cfg.workflow.autoApproveSpec = true;
    cfg.workflow.autoApprovePlan = true;
  }
  store.set({ config: cfg, projectDir, overrides });
}

function reload() {
  const { projectDir, overrides } = store.get();
  load(projectDir, overrides);
}

function useConfig(): Config {
  const config = store.use(s => s.config);
  if (!config) throw new Error('configStore.load must be called before rendering');
  return config;
}

export const configStore = { ...storeBase(store), load, reload, useConfig };
