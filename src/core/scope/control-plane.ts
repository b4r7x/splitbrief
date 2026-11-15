import { realpathSync } from 'node:fs';
import { resolve, sep, relative, dirname } from 'node:path';
import {
  assertNotHardlink,
  assertWritablePathConfined,
  nearestExistingAncestor,
} from '../../lib/fs/confinement.js';
import { error } from '../../utils/error.js';
import { SPLITBRIEF_IDENTITY } from '../identity.js';

export const CONTROL_PLANE_SEGMENTS: ReadonlySet<string> = new Set([
  '.git',
  SPLITBRIEF_IDENTITY.stateDir,
]);

function controlPlaneError(relativePath: string) {
  return error(
    'path-confined-control-plane',
    `unsafe path: refusing to write into control plane (.git/.splitbrief): ${relativePath}`,
    { relativePath },
  );
}

function firstSegment(root: string, target: string): string {
  const rel = relative(root, target);
  return rel.split(sep)[0] ?? '';
}

/**
 * `relativePath` reaches splitbrief's control plane (`.git`/`.splitbrief`): as
 * spelled, or through an in-repo symlink whose realpath resolves into it.
 */
export function reachesControlPlane(relativePath: string, rootDir: string): boolean {
  const lexicalTarget = resolve(rootDir, relativePath);
  if (CONTROL_PLANE_SEGMENTS.has(firstSegment(resolve(rootDir), lexicalTarget))) return true;
  let realTarget: string;
  try {
    realTarget = realpathSync(lexicalTarget);
  } catch {
    realTarget = nearestExistingAncestor(dirname(lexicalTarget));
  }
  return CONTROL_PLANE_SEGMENTS.has(firstSegment(nearestExistingAncestor(rootDir), realTarget));
}

/**
 * Guard for a write of project content (a promoted, restored or seeded entry): in
 * addition to confinement, rejects writes that reach splitbrief's control plane,
 * lexically or through an in-repo symlink.
 */
export function assertProjectWritablePathConfined(relativePath: string, rootDir: string): void {
  assertWritablePathConfined(relativePath, rootDir);
  if (reachesControlPlane(relativePath, rootDir)) {
    throw controlPlaneError(relativePath);
  }
}

/**
 * Stricter guard for paths whose name comes from the model (`task.file`).
 * In addition to confinement, rejects writes that reach splitbrief's control plane
 * (`.git`/`.splitbrief`) — lexically, through an in-repo symlink whose realpath
 * resolves into the control plane, or through a hardlink to a control-plane file.
 * splitbrief's own writes into `.splitbrief/` use `assertWritablePathConfined` directly
 * and are not subject to this control-plane rejection.
 */
export function assertModelWritablePathConfined(relativePath: string, rootDir: string): void {
  assertProjectWritablePathConfined(relativePath, rootDir);
  assertNotHardlink(relativePath, resolve(rootDir, relativePath));
}
