import { join } from 'node:path';
import { writeSecureFile } from '../../lib/fs.js';
import type { Task } from '../../core/schemas/task.js';
import type { HandoffManifest } from '../../core/schemas/handoff-manifest.js';
import type { HandoffTarget } from '../../core/handoff/targets.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { HandoffManifestSchema } from '../../core/schemas/handoff-manifest.js';
import { hashTaskBrief } from '../brief-hash.js';
import { nowIso } from '../../utils/format-time.js';

export type BuildManifestOptions = {
  sessionId: string;
  splitbriefVersion: string;
  target: HandoffTarget | string;
  mode: WorkflowMode;
  tasks: Task[];
  packFiles: string[];
  spec?: string | null;
  plan?: string | null;
  constitution?: string | null;
  validation?: { typecheck?: string; lint?: string; test?: string };
  sourceCommit?: string;
};

export function buildManifest(options: BuildManifestOptions): HandoffManifest {
  const briefHash = hashTaskBrief(options.tasks);

  const taskFiles = options.packFiles.filter((f) => f.startsWith('tasks/'));

  const artifacts: HandoffManifest['artifacts'] = {
    tasks: taskFiles,
    ...(options.spec != null && { spec: 'spec.md' as const }),
    ...(options.plan != null && { plan: 'plan.md' as const }),
    ...(options.constitution != null && { constitution: 'constitution.md' as const }),
  };

  const manifest = {
    packVersion: '1' as const,
    splitbriefVersion: options.splitbriefVersion,
    generatedAt: nowIso(),
    sessionId: options.sessionId,
    briefHash,
    ...(options.sourceCommit !== undefined && { sourceCommit: options.sourceCommit }),
    target: options.target,
    mode: options.mode,
    taskIds: options.tasks.map((t) => t.id),
    artifacts,
    validation: options.validation ?? {},
  };

  return HandoffManifestSchema.parse(manifest);
}

export function writeManifest(outDir: string, manifest: HandoffManifest): void {
  writeSecureFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
