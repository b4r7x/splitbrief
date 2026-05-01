import { existsSync, rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Config } from '../../../core/schemas/config.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { ApprovalGrant } from '../../../core/schemas/approval-store.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import type { ApprovalTier, TierMap } from './action-classifier.js';
import { classifyAction, extractActionPattern, matchesActionPattern } from './action-classifier.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';
import { readApprovalsStore, writeApprovalsStore } from '../approvals-store.js';
import { DIPTYCH_DIR, TREES_DIR } from '../../../core/paths.js';
import {
  discardChangedFiles,
  getCommittedFilesSince,
  getCurrentChangedFiles,
  getCurrentCommitSha,
} from '../../../lib/git.js';

export type { TieredApprovalRequest, TieredApprovalResponse } from '../../../core/approval/types.js';

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
  confirmReason?: string;
  confirmApprovals?: Array<{
    tier: 'confirm';
    actionClass: ActionClass;
    actionDescription: string;
    reason: string;
  }>;
};

export type ChangedFilesSnapshot = {
  head: string;
  files: string[];
  /** Content of each dirty file at snapshot time, keyed by relative path. Used for dirty-at-start change detection and safe rollback. */
  dirtyFileContents: Record<string, string | null>;
};

export type FileContentSnapshot = Record<string, string | null>;

export type RestoreChangedFilesResult = {
  restoredFiles: string[];
  conflictedFiles: string[];
};

export type StagedProject = {
  projectDir: string;
  snapshot: ChangedFilesSnapshot;
  cleanup: () => void;
};

export type GateChangedFilesInput = Omit<GateActionInput, 'actionDescription'> & {
  changedFiles: string[];
};

export type GateChangedFilesDecision = GateDecision & {
  changedFiles: string[];
  rejectedFile?: string;
};

function isConfiguredHeadless(config: Config): boolean {
  return config.approval?.headless === true;
}

function uniqueProjectFiles(files: string[]): string[] {
  return Array.from(new Set(files))
    .filter((file) => file.length > 0)
    .filter((file) => !file.startsWith(`${DIPTYCH_DIR}/`))
    .sort();
}

export async function getChangedFilesSnapshot(projectDir: string): Promise<ChangedFilesSnapshot> {
  const files = uniqueProjectFiles(await getCurrentChangedFiles(projectDir));
  const entries = await Promise.all(files.map(async (file): Promise<[string, string | null]> => {
    try {
      return [file, await readFile(join(projectDir, file), 'utf-8')];
    } catch {
      return [file, null];
    }
  }));
  const dirtyFileContents: Record<string, string | null> = Object.fromEntries(entries);
  return {
    head: await getCurrentCommitSha(projectDir),
    files,
    dirtyFileContents,
  };
}

export async function getChangedFilesSinceSnapshot(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
): Promise<string[]> {
  const baseline = new Set(snapshot.files);
  const currentFiles = uniqueProjectFiles(await getCurrentChangedFiles(projectDir));

  // Files not in baseline: new changes by implementer
  const newChanges = currentFiles.filter((file) => !baseline.has(file));

  // Already-dirty files where implementer made further changes (compare content to snapshot)
  const modifiedDirtyResults = await Promise.all(
    currentFiles
      .filter((file) => baseline.has(file) && snapshot.dirtyFileContents[file] !== undefined)
      .map(async (file): Promise<string | null> => {
        const storedContent = snapshot.dirtyFileContents[file];
        try {
          return (await readFile(join(projectDir, file), 'utf-8')) !== storedContent ? file : null;
        } catch {
          return storedContent !== null ? file : null;
        }
      }),
  );
  const modifiedDirtyFiles = modifiedDirtyResults.filter((f): f is string => f !== null);

  const committedFiles = uniqueProjectFiles(await getCommittedFilesSince(projectDir, snapshot.head));
  return Array.from(new Set([...newChanges, ...modifiedDirtyFiles, ...committedFiles]))
    .filter((file) => !file.startsWith(`${DIPTYCH_DIR}/`))
    .sort();
}

async function readCurrentFileContent(projectDir: string, file: string): Promise<string | null> {
  try {
    return await readFile(join(projectDir, file), 'utf-8');
  } catch {
    return null;
  }
}

async function writeCurrentFileContent(projectDir: string, file: string, content: string | null): Promise<void> {
  const path = join(projectDir, file);
  if (content === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

export async function captureCurrentFileContents(projectDir: string, files: string[]): Promise<FileContentSnapshot> {
  const entries = await Promise.all(files.map(async (file): Promise<[string, string | null]> =>
    [file, await readCurrentFileContent(projectDir, file)],
  ));
  return Object.fromEntries(entries);
}

export async function restoreDirtyFilesFromSnapshot(
  projectDir: string,
  snapshot: ChangedFilesSnapshot,
  files: string[],
  expectedCurrentContents: FileContentSnapshot = {},
): Promise<RestoreChangedFilesResult> {
  const toDiscard: string[] = [];
  const restoredFiles: string[] = [];
  const conflictedFiles: string[] = [];

  for (const file of files) {
    if (
      Object.hasOwn(expectedCurrentContents, file) &&
      (await readCurrentFileContent(projectDir, file)) !== expectedCurrentContents[file]
    ) {
      conflictedFiles.push(file);
      continue;
    }

    const storedContent = snapshot.dirtyFileContents[file];
    if (storedContent !== undefined) {
      if (storedContent === null) {
        const path = join(projectDir, file);
        if (existsSync(path)) await rm(path, { force: true });
      } else {
        await writeFile(join(projectDir, file), storedContent, 'utf-8');
      }
      restoredFiles.push(file);
    } else {
      toDiscard.push(file);
    }
  }
  if (toDiscard.length > 0) {
    await discardChangedFiles(projectDir, toDiscard);
    restoredFiles.push(...toDiscard);
  }

  return { restoredFiles, conflictedFiles };
}

export async function createStagedProject(projectDir: string): Promise<StagedProject> {
  const snapshot = await getChangedFilesSnapshot(projectDir);
  const stagedRoot = await mkdtemp(join(tmpdir(), 'diptych-stage-'));
  const stagedProjectDir = join(stagedRoot, basename(projectDir));
  await cp(projectDir, stagedProjectDir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const name = basename(source);
      return name !== 'node_modules' && name !== DIPTYCH_DIR && name !== TREES_DIR;
    },
  });
  return {
    projectDir: stagedProjectDir,
    snapshot,
    cleanup: () => {
      rmSync(stagedRoot, { recursive: true, force: true });
    },
  };
}

export type PromoteStagedChangesResult = {
  promotedFiles: string[];
  conflictedFiles: string[];
};

export async function promoteStagedChanges(
  projectDir: string,
  stagedProjectDir: string,
  files: string[],
  expectedCurrentContents: FileContentSnapshot,
): Promise<PromoteStagedChangesResult> {
  const promotedFiles: string[] = [];
  const conflictResults = await Promise.all(
    files.map(async (file): Promise<string | null> => {
      if (!Object.hasOwn(expectedCurrentContents, file)) return null;
      return (await readCurrentFileContent(projectDir, file)) !== expectedCurrentContents[file] ? file : null;
    }),
  );
  const conflictedFiles = conflictResults.filter((f): f is string => f !== null);

  if (conflictedFiles.length > 0) {
    return { promotedFiles, conflictedFiles };
  }

  for (const file of files) {
    await writeCurrentFileContent(projectDir, file, await readCurrentFileContent(stagedProjectDir, file));
    promotedFiles.push(file);
  }

  return { promotedFiles, conflictedFiles };
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
      allowedPaths: config.approval?.allowedPaths,
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
    const classifyContext = {
      actionDescription,
      taskFile: task.file,
      taskInBounds: taskScopePatterns(task),
      dependsOnFiles,
      projectDir,
    };
    const grantPattern = extractActionPattern(classifyContext);

    // Match always grant (exact pattern OR pattern matches current target)
    const alwaysGrant = grants.find((g) =>
      g.class === actionClass &&
      g.scope === 'always' &&
      (g.pattern === actionDescription || matchesActionPattern(grantPattern, g.pattern)),
    );
    if (alwaysGrant) {
      bus.publish({ type: 'approval_granted', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), scope: 'always' });
      return { allow: true };
    }

    // Match session grant for current session
    const sessionGrant = grants.find((g) =>
      g.class === actionClass &&
      g.scope === 'session' &&
      g.sessionId === sessionId &&
      (g.pattern === actionDescription || matchesActionPattern(grantPattern, g.pattern)),
    );
    if (sessionGrant) {
      bus.publish({ type: 'approval_granted', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), scope: 'session' });
      return { allow: true };
    }

    // No grant found
    if (!callbacks.onTieredApproval || isConfiguredHeadless(config)) {
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
          pattern: grantPattern,
          class: actionClass,
          scope: response.scope,
          sessionId: response.scope === 'session' ? sessionId : undefined,
          grantedAt: new Date().toISOString(),
        };
        upsertApprovalGrant(projectDir, grant);
        bus.publish({ type: 'approval_sticky_recorded', ts: Date.now(), phase, pattern: grantPattern, scope: response.scope, actionClass });
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
    if (!callbacks.onTieredApproval || isConfiguredHeadless(config)) {
      bus.publish({ type: 'approval_rejected', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), reason: 'APPROVAL_REQUIRED' });
      return { allow: false, reason: 'APPROVAL_REQUIRED', tier, actionClass, actionDescription };
    }

    const response = await callbacks.onTieredApproval(request);

    if (response.decision === 'confirm') {
      if (response.phrase !== 'I confirm' || !response.reason) {
        bus.publish({ type: 'approval_rejected', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), reason: 'invalid_confirm_phrase' });
        return { allow: false, reason: 'invalid_confirm_phrase', tier, actionClass, actionDescription };
      }
      bus.publish({
        type: 'approval_granted',
        ts: Date.now(),
        phase,
        tier,
        actionClass,
        ...(taskId !== undefined && { taskId }),
        scope: 'once',
        confirmReason: response.reason,
      });
      return {
        allow: true,
        tier,
        actionClass,
        actionDescription,
        confirmReason: response.reason,
        confirmApprovals: [{ tier, actionClass, actionDescription, reason: response.reason }],
      };
    }

    if (response.decision === 'deny') {
      bus.publish({ type: 'approval_rejected', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), reason: response.reason });
      return { allow: false, reason: response.reason, tier, actionClass, actionDescription };
    }

    // allow on confirm tier is invalid: confirm tier requires the explicit confirm phrase + reason.
    bus.publish({ type: 'approval_rejected', ts: Date.now(), phase, tier, actionClass, ...(taskId !== undefined && { taskId }), reason: 'invalid_confirm_response' });
    return { allow: false, reason: 'invalid_confirm_response', tier, actionClass, actionDescription };
  }

  tier satisfies never;
  throw new Error('unreachable: unknown approval tier');
}

export async function gateChangedFiles(input: GateChangedFilesInput): Promise<GateChangedFilesDecision> {
  const changedFiles = Array.from(new Set(input.changedFiles)).sort();
  const confirmApprovals: NonNullable<GateDecision['confirmApprovals']> = [];
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
    if (decision.confirmApprovals) confirmApprovals.push(...decision.confirmApprovals);
  }

  const firstConfirm = confirmApprovals[0];
  return {
    allow: true,
    changedFiles,
    ...(firstConfirm ? {
      confirmReason: firstConfirm.reason,
      confirmApprovals,
    } : {}),
  };
}
