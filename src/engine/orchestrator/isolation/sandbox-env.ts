import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import {
  createRunnerSandboxEnv,
  runnerSandboxIdentity,
  withPrependedPathDirectory,
} from '../../runners/sandbox/env.js';
import { removeSandboxTempDirs } from '../../runners/sandbox/state/paths.js';
import type { IsolationRole } from './types.js';

const NODE_MODULES = 'node_modules';

/**
 * The sandbox envs of one run's workspaces. createRunnerSandboxEnv re-bridges the runner's own
 * host CLI state on every call, so an env is built once per runner and reused for the rest of the
 * run.
 */
export function createWorkspaceSandboxEnvs(): {
  workspaceEnv: (
    dir: string,
    role: IsolationRole,
    config: Config,
    sandboxDir?: string,
  ) => Promise<NodeJS.ProcessEnv>;
  resumedEnv: (dir: string, role: IsolationRole, config: Config) => Promise<NodeJS.ProcessEnv>;
  seedImplementerEnv: (dir: string, config: Config, env: NodeJS.ProcessEnv) => void;
  removeResumedRoots: () => Promise<void>;
} {
  const envMemo = new Map<string, Promise<NodeJS.ProcessEnv>>();
  const resumedSandboxRoots: string[] = [];

  // The role reaches createRunnerSandboxEnv so each one bridges into its own
  // <worktree>/.splitbrief/sandbox/<role>: a role's acquisition clears only
  // what it bridged, never the snapshot the other role's memoised env is still
  // pointed at. envMemo is keyed on the runner too, so a task profile
  // overriding config.implementer gets its own rather than the first runner's
  // auth-key allowlist and bridged tool.
  function memoKey(dir: string, role: IsolationRole, config: Config): string {
    return `${dir}\u0000${role}\u0000${runnerSandboxIdentity(config[role])}`;
  }

  function sandboxEnvFor(
    dir: string,
    role: IsolationRole,
    config: Config,
    sandboxDir: string,
  ): Promise<NodeJS.ProcessEnv> {
    const key = memoKey(sandboxDir, role, config);
    let env = envMemo.get(key);
    if (env === undefined) {
      env = createRunnerSandboxEnv(dir, config[role], role, sandboxDir);
      envMemo.set(key, env);
    }
    return env;
  }

  async function envWithProjectBin(
    dir: string,
    role: IsolationRole,
    config: Config,
    sandboxDir: string,
  ): Promise<NodeJS.ProcessEnv> {
    const env = await sandboxEnvFor(dir, role, config, sandboxDir);
    let binDir: string;
    try {
      binDir = await realpath(join(dir, NODE_MODULES, '.bin'));
    } catch {
      return env;
    }
    return withPrependedPathDirectory(env, binDir);
  }

  return {
    workspaceEnv: (dir, role, config, sandboxDir = dir) =>
      envWithProjectBin(dir, role, config, sandboxDir),
    resumedEnv: async (dir, role, config) => {
      // Re-entry must never refresh credentials through a stopped workspace path.
      const root = await mkdtemp(join(tmpdir(), 'splitbrief-resume-env-'));
      resumedSandboxRoots.push(root);
      return envWithProjectBin(dir, role, config, root);
    },
    seedImplementerEnv: (dir, config, env) => {
      envMemo.set(memoKey(dir, 'implementer', config), Promise.resolve(env));
    },
    removeResumedRoots: async () => {
      for (const root of resumedSandboxRoots) {
        await rm(root, { recursive: true, force: true });
        removeSandboxTempDirs(root);
      }
      resumedSandboxRoots.length = 0;
    },
  };
}
