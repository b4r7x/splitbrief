import { createStore, storeBase } from './create-store.js';
import { loadConfig, writeConfig } from '../core/config.js';
import { feedbackStore } from './error.js';
import { WORKFLOW_MODES } from '../types.js';
import type { Config, PlannerTool, WorkflowMode } from '../types.js';

interface CLIOverrides {
  planner?: { tool?: string; model?: string; command?: string };
  implementer?: { provider?: string; model?: string; command?: string };
  contextLength?: number;
  autoApprove?: boolean;
  mode?: string;
}

interface ConfigState {
  config: Config | null;
  projectDir: string;
  overrides: CLIOverrides;
}

const empty: ConfigState = {
  config: null,
  projectDir: '',
  overrides: {},
};

const store = createStore<ConfigState>(empty);

function load(projectDir: string, overrides: CLIOverrides = {}) {
  const cfg = loadConfig(projectDir);
  if (overrides.contextLength !== undefined) cfg.implementer.contextLength = overrides.contextLength;
  if (overrides.planner?.tool !== undefined) cfg.planner.tool = overrides.planner.tool as PlannerTool;
  if (overrides.planner?.model !== undefined) cfg.planner.model = overrides.planner.model;
  if (overrides.planner?.command !== undefined) cfg.planner.command = overrides.planner.command;
  if (overrides.implementer?.provider !== undefined) cfg.implementer.provider = overrides.implementer.provider;
  if (overrides.implementer?.model !== undefined) cfg.implementer.model = overrides.implementer.model;
  if (overrides.implementer?.command !== undefined) cfg.implementer.command = overrides.implementer.command;
  if (overrides.autoApprove !== undefined) {
    cfg.workflow.autoApproveSpec = overrides.autoApprove;
    cfg.workflow.autoApprovePlan = overrides.autoApprove;
  }
  if (overrides.mode !== undefined) {
    const valid = WORKFLOW_MODES;
    if (!valid.includes(overrides.mode as WorkflowMode)) {
      throw new Error(`Invalid workflow mode: ${overrides.mode}. Must be: ${valid.join(', ')}`);
    }
    cfg.workflow.mode = overrides.mode as WorkflowMode;
  }
  store.set({ config: cfg, projectDir, overrides });
}

function reload() {
  const { projectDir, overrides } = store.get();
  load(projectDir, overrides);
}

function save(updated: Config) {
  const { projectDir } = store.get();
  if (!projectDir) throw new Error('configStore.load must be called before save');
  try {
    writeConfig(projectDir, updated);
    store.set(s => ({ ...s, config: updated }));
  } catch (err) {
    feedbackStore.setError(`Failed to save config: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function useConfig(): Config {
  const config = store.use(s => s.config);
  if (!config) throw new Error('configStore.load must be called before rendering');
  return config;
}

export const configStore = { ...storeBase(store), set: store.set, load, reload, save, useConfig };
