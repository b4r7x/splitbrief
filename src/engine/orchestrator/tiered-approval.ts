import { execFileSync } from 'node:child_process';
import type { Config } from '../../core/schemas/config.js';
import type { Task, TaskId } from '../../core/schemas/task.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { ActionClass, ApprovalGrant } from '../../core/schemas/approval-store.js';
import type { ApprovalTier, TierMap } from './action-classifier.js';
import { classifyAction } from './action-classifier.js';
import type { OrchestratorCallbacks } from './types.js';
import type { EventBus } from '../events/types.js';
import { readApprovalsStore, writeApprovalsStore } from './approvals-store.js';
import { DIPTYCH_DIR } from '../../core/paths.js';

export type TieredApprovalRequest = {
  tier: ApprovalTier;
  actionClass: ActionClass;
  actionDescription: string;
  taskId?: TaskId;
  phase: Phase;
};

export type TieredApprovalResponse =
  | { decision: 'allow'; scope: 'once' | 'session' | 'always' }
  | { decision: 'deny'; reason: string }
  | { decision: 'confirm'; phrase: string; reason: string };

export type GateActionInput = {
  actionDescription: string;
  task: Task;
  dependsOnFiles: string[];
  projectDir: string;
  sessionId: string;
  phase: Phase;
  taskId?: TaskId;
  bus: EventBus;
  callbacks: OrchestratorCallbacks;
  config: Config;
};

export type GateDecision = {
  allow: boolean;
  reason?: string;
  tier?: ApprovalTier;
  actionClass?: ActionClass;
  actionDescription?: string;
};

export type ChangedFilesSnapshot = {
  head: string;
  files: string[];
};

export type GateChangedFilesInput = Omit<GateActionInput, 'actionDescription'> & {
  changedFiles: string[];
};

export type GateChangedFilesDecision = GateDecision & {
  changedFiles: string[];
  rejectedFile?: string;
};

function isHeadless(config: Config): boolean {
  return config.approval?.headless === true || !process.stdout.isTTY;
}

function uniqueProjectFiles(files: string[]): string[] {
  return Array.from(new Set(files))
    .filter((file) => file.length > 0)
    .filter((file) => !file.startsWith(`${DIPTYCH_DIR}/`))
    .sort();
}

function parseStatusFiles(output: string): string[] {
  if (output.trim().length === 0) return [];
  return uniqueProjectFiles(output
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const withoutStatus = line.length > 3 ? line.slice(3).trim() : line.trim();
      const renameTarget = withoutStatus.split(' -> ').at(-1);
      return renameTarget ?? withoutStatus;
    }));
}

function parseNameOnlyFiles(output: string): string[] {
  if (output.trim().length === 0) return [];
  return uniqueProjectFiles(output
    .split('\n')
    .map((line) => line.trim()));
}

function runGit(projectDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function getCurrentCommitSha(projectDir: string): string {
  const out = runGit(projectDir, ['rev-parse', 'HEAD']).trim();
  return out.length > 0 ? out : 'HEAD';
}

function getCurrentChangedFiles(projectDir: string): string[] {
  return parseStatusFiles(runGit(projectDir, ['status', '--porcelain=v1', '--untracked-files=all']));
}

function getCommittedFilesSince(projectDir: string, baseRef: string): string[] {
  const out = runGit(projectDir, ['diff', '--name-only', baseRef, 'HEAD']);
  return parseNameOnlyFiles(out);
}

export function getChangedFilesSnapshot(projectDir: string): ChangedFilesSnapshot {
  return {
    head: getCurrentCommitSha(projectDir),
    files: getCurrentChangedFiles(projectDir),
  };
}

export function getChangedFilesSinceSnapshot(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
): string[] {
  const baseline = new Set(snapshot.files);
  const currentFiles = getCurrentChangedFiles(projectDir).filter((file) => !baseline.has(file));
  const committedFiles = getCommittedFilesSince(projectDir, snapshot.head);
  return Array.from(new Set([...currentFiles, ...committedFiles]))
    .filter((file) => !file.startsWith(`${DIPTYCH_DIR}/`))
    .sort();
}

function taskScopePatterns(task: Task): string[] {
  return [
    ...(task.scope?.inBounds ?? []),
    ...(task.scope?.approvedOutOfBounds ?? []),
  ];
}

function upsertApprovalGrant(projectDir: string, grant: ApprovalGrant): void {
  const store = readApprovalsStore(projectDir);
  const grants = store.grants;

  // If an 'always' grant exists for same pattern+class, leave it and skip
  const alwaysExists = grants.some(
    (g) => g.pattern === grant.pattern && g.class === grant.class && g.scope === 'always',
  );
  if (alwaysExists && grant.scope === 'session') return;

  // Replace existing session grant for same pattern+class, or add
  const filtered = grants.filter(
    (g) => !(g.pattern === grant.pattern && g.class === grant.class && g.scope === grant.scope),
  );
  filtered.push(grant);

  writeApprovalsStore(projectDir, { version: 1, grants: filtered });
}

export async function gateAction(input: GateActionInput): Promise<GateDecision> {
  const { actionDescription, task, dependsOnFiles, projectDir, sessionId, phase, taskId, bus, callbacks, config } = input;

  if (config.approval?.enabled === false) {
    return { allow: true };
  }

  // Strip undefined values from tiers to satisfy Partial<Record<ActionClass, ApprovalTier>>
  const rawTiers = config.approval?.tiers;
  const tierOverrides: TierMap | undefined = rawTiers
    ? (Object.fromEntries(Object.entries(rawTiers).filter(([, v]) => v !== undefined)) as TierMap)
    : undefined;
  const { actionClass, tier } = classifyAction(
    {
      actionDescription,
      taskFile: task.file,
      taskInBounds: taskScopePatterns(task),
      dependsOnFiles,
      projectDir,
    },
    tierOverrides,
  );

  if (tier === 'auto') {
    return { allow: true };
  }

  bus.publish({ type: 'approval_prompted', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }) });

  const request: TieredApprovalRequest = { tier, actionClass, actionDescription, phase, ...(taskId !== undefined && { taskId }) };

  if (tier === 'sticky') {
    const grants = readApprovalsStore(projectDir).grants;

    // Match always grant
    const alwaysGrant = grants.find((g) => g.pattern === actionDescription && g.class === actionClass && g.scope === 'always');
    if (alwaysGrant) {
      bus.publish({ type: 'approval_granted', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), scope: 'always' });
      return { allow: true };
    }

    // Match session grant for current session
    const sessionGrant = grants.find((g) => g.pattern === actionDescription && g.class === actionClass && g.scope === 'session' && g.sessionId === sessionId);
    if (sessionGrant) {
      bus.publish({ type: 'approval_granted', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), scope: 'session' });
      return { allow: true };
    }

    // No grant found
    if (!callbacks.onTieredApproval || isHeadless(config)) {
      bus.publish({ type: 'approval_rejected', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), reason: 'APPROVAL_REQUIRED' });
      return { allow: false, reason: 'APPROVAL_REQUIRED', tier, actionClass, actionDescription };
    }

    const response = await callbacks.onTieredApproval(request);

    if (response.decision === 'deny') {
      bus.publish({ type: 'approval_rejected', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), reason: response.reason });
      return { allow: false, reason: response.reason, tier, actionClass, actionDescription };
    }

    if (response.decision === 'allow') {
      if (response.scope === 'session' || response.scope === 'always') {
        const grant: ApprovalGrant = {
          pattern: actionDescription,
          class: actionClass,
          scope: response.scope,
          sessionId: response.scope === 'session' ? sessionId : undefined,
          grantedAt: new Date().toISOString(),
        };
        upsertApprovalGrant(projectDir, grant);
        bus.publish({ type: 'approval_sticky_recorded', ts: Date.now(), phase, pattern: actionDescription, scope: response.scope, actionClass });
        bus.publish({ type: 'approval_granted', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), scope: response.scope });
        return { allow: true };
      }
      // scope === 'once' — no persistence
      bus.publish({ type: 'approval_granted', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), scope: 'once' });
      return { allow: true };
    }

    // confirm response on sticky tier — treat as deny (unexpected)
    bus.publish({ type: 'approval_rejected', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), reason: 'unexpected_confirm_on_sticky' });
    return { allow: false, reason: 'unexpected_confirm_on_sticky', tier, actionClass, actionDescription };
  }

  if (tier === 'confirm') {
    if (!callbacks.onTieredApproval || isHeadless(config)) {
      bus.publish({ type: 'approval_rejected', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), reason: 'APPROVAL_REQUIRED' });
      return { allow: false, reason: 'APPROVAL_REQUIRED', tier, actionClass, actionDescription };
    }

    const response = await callbacks.onTieredApproval(request);

    if (response.decision === 'confirm') {
      if (response.phrase !== 'I confirm' || !response.reason) {
        bus.publish({ type: 'approval_rejected', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), reason: 'invalid_confirm_phrase' });
        return { allow: false, reason: 'invalid_confirm_phrase', tier, actionClass, actionDescription };
      }
      bus.publish({ type: 'approval_granted', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), scope: 'once' });
      return { allow: true };
    }

    if (response.decision === 'deny') {
      bus.publish({ type: 'approval_rejected', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), reason: response.reason });
      return { allow: false, reason: response.reason, tier, actionClass, actionDescription };
    }

    // allow on confirm tier — treat as allow once
    bus.publish({ type: 'approval_granted', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), scope: 'once' });
    return { allow: true };
  }

  tier satisfies never;
  throw new Error('unreachable: unknown approval tier');
}

export async function gateChangedFiles(input: GateChangedFilesInput): Promise<GateChangedFilesDecision> {
  const changedFiles = Array.from(new Set(input.changedFiles)).sort();
  for (const file of changedFiles) {
    const actionDescription = `write ${file}`;
    const decision = await gateAction({
      ...input,
      actionDescription,
    });
    if (!decision.allow) {
      return {
        ...decision,
        changedFiles,
        rejectedFile: file,
        actionDescription,
      };
    }
  }

  return {
    allow: true,
    changedFiles,
  };
}
