import { basename } from 'node:path';
import { resolveRenderAttachment } from '../../core/attachments/resolve.js';
import { verificationKey } from '../../core/review/verdict.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import type { EvidenceCheckEntry, EvidenceLedger } from '../../core/schemas/evidence.js';
import type { ReviewVerdict } from '../../core/schemas/review.js';
import type { Check } from '../../core/schemas/task.js';

/** The most images one render check sends the reviewer; the prompt names the rest. */
export const MAX_RENDER_IMAGES_PER_CHECK = 4;

export const NO_VISION_REVIEW =
  'No vision review happened: the reviewer could not receive these images.';

const RENDER_CRITIQUE_INSTRUCTION =
  "Write one critique per rendered scenario into the matching criterion's evidence, or raise a finding naming it.";

type RenderArtifact = Readonly<{
  checkId: string;
  scenario: string;
  path: string;
}>;

type MissingRender = Readonly<{
  checkId: string;
  scenario: string;
  paths: readonly string[];
}>;

type ReviewRenders = Readonly<{
  artifacts: readonly RenderArtifact[];
  /** The attachments to send, at most `MAX_RENDER_IMAGES_PER_CHECK` per check. */
  images: readonly Attachment[];
  /** The render checks with at least one image being sent. */
  attachedCheckIds: readonly string[];
  /** The render checks the reviewer received no image for. */
  missingCheckIds: readonly string[];
  /** The prompt section, absent when the registry holds no render check. */
  section: string | undefined;
}>;

/**
 * The render PNGs the checks log recorded for the current candidate: the latest
 * entry per check id whose workspace snapshot matches, so an artifact from an
 * earlier candidate can never stand in for a render this run did not produce.
 */
function collectRenderArtifacts(input: {
  ledger: EvidenceLedger | null;
  registry: ReadonlyMap<string, Check>;
  currentCandidateId: string | undefined;
}): readonly RenderArtifact[] {
  const latest = new Map<string, EvidenceCheckEntry>();
  const entries = [
    ...(input.ledger?.tasks ?? []).flatMap((task) => task.checks ?? []),
    ...(input.ledger?.verifyChecks ?? []),
  ];
  for (const entry of entries) {
    const check = input.registry.get(entry.id);
    if (check === undefined || check.kind !== 'render') continue;
    if (entry.workspaceSnapshotId !== input.currentCandidateId) continue;
    const previous = latest.get(entry.id);
    if (previous === undefined || entry.ts >= previous.ts) latest.set(entry.id, entry);
  }
  const artifacts: RenderArtifact[] = [];
  const seen = new Set<string>();
  for (const [checkId, entry] of latest) {
    const check = input.registry.get(checkId);
    if (check === undefined) continue;
    for (const artifact of entry.artifacts ?? []) {
      if (!artifact.path.toLowerCase().endsWith('.png')) continue;
      const key = `${checkId}\u0000${artifact.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push({ checkId, scenario: check.value, path: artifact.path });
    }
  }
  return artifacts;
}

function renderLines(artifacts: readonly RenderArtifact[]): string {
  return artifacts.map((artifact) => `- ${artifact.scenario} → ${artifact.path}`).join('\n');
}

function missingLines(missing: readonly MissingRender[]): string {
  const lines: string[] = [];
  for (const entry of missing) {
    const paths = entry.paths.length > 0 ? entry.paths.join(', ') : 'no image produced';
    lines.push(`- ${entry.scenario} → ${paths}`);
  }
  return lines.join('\n');
}

/**
 * The order a check's PNGs are attached in, whatever order the checks log lists
 * them: every `frame.png` first, then the other PNGs, each group by path.
 */
function selectionOrder(artifacts: readonly RenderArtifact[]): RenderArtifact[] {
  const byPath = [...artifacts].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return [
    ...byPath.filter((artifact) => basename(artifact.path) === 'frame.png'),
    ...byPath.filter((artifact) => basename(artifact.path) !== 'frame.png'),
  ];
}

function renderSection(input: {
  attached: readonly RenderArtifact[];
  notAttached: readonly RenderArtifact[];
  missing: readonly MissingRender[];
}): string {
  const lines: string[] = [];
  if (input.attached.length > 0) {
    lines.push('The rendered scenarios are attached as images.', '', renderLines(input.attached));
  }
  if (input.notAttached.length > 0) {
    lines.push(
      '',
      `Rendered but not attached (over the cap of ${MAX_RENDER_IMAGES_PER_CHECK} per check, or unreadable):`,
      '',
      renderLines(input.notAttached),
    );
  }
  if (input.missing.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Rendered scenarios (not attached):', '', missingLines(input.missing));
  }
  if (input.attached.length > 0) lines.push('', RENDER_CRITIQUE_INSTRUCTION);
  if (input.missing.length > 0) lines.push('', NO_VISION_REVIEW);
  return lines.join('\n');
}

/**
 * The renders the review input carries. Each render check is judged on its own
 * latest execution on the current candidate: when the seat can take images, up
 * to `MAX_RENDER_IMAGES_PER_CHECK` of its PNGs that resolve are attached in
 * `selectionOrder`, and the prompt names the PNGs left out. A check with no
 * attached image goes in a manifest beside the plain no-vision statement. An
 * artifact from an earlier candidate is never delivered.
 */
export function reviewRenders(input: {
  ledger: EvidenceLedger | null;
  registry: ReadonlyMap<string, Check>;
  projectDir: string;
  seatSupportsImages: boolean;
  currentCandidateId: string | undefined;
}): ReviewRenders {
  const artifacts = collectRenderArtifacts({
    ledger: input.ledger,
    registry: input.registry,
    currentCandidateId: input.currentCandidateId,
  });
  const renderChecks = [...input.registry.values()].filter((check) => check.kind === 'render');
  if (renderChecks.length === 0) {
    return {
      artifacts,
      images: [],
      attachedCheckIds: [],
      missingCheckIds: [],
      section: undefined,
    };
  }
  const artifactsByCheck = new Map<string, RenderArtifact[]>();
  for (const artifact of artifacts) {
    const list = artifactsByCheck.get(artifact.checkId);
    if (list === undefined) artifactsByCheck.set(artifact.checkId, [artifact]);
    else list.push(artifact);
  }
  const images: Attachment[] = [];
  const attachedCheckIds: string[] = [];
  const attached: RenderArtifact[] = [];
  const notAttached: RenderArtifact[] = [];
  const missing: MissingRender[] = [];
  for (const check of renderChecks) {
    const checkArtifacts = artifactsByCheck.get(check.id) ?? [];
    const ordered = selectionOrder(checkArtifacts);
    const checkAttached = new Set<RenderArtifact>();
    if (input.seatSupportsImages) {
      for (const artifact of ordered) {
        if (checkAttached.size === MAX_RENDER_IMAGES_PER_CHECK) break;
        const resolved = resolveRenderAttachment({
          path: artifact.path,
          projectDir: input.projectDir,
        });
        if (!resolved.ok) continue;
        images.push(resolved.attachment);
        checkAttached.add(artifact);
      }
    }
    if (checkAttached.size === 0) {
      missing.push({
        checkId: check.id,
        scenario: check.value,
        paths: checkArtifacts.map((artifact) => artifact.path),
      });
      continue;
    }
    attachedCheckIds.push(check.id);
    attached.push(...checkAttached);
    notAttached.push(...ordered.filter((artifact) => !checkAttached.has(artifact)));
  }
  return {
    artifacts,
    images,
    attachedCheckIds,
    missingCheckIds: missing.map((entry) => entry.checkId),
    section: renderSection({ attached, notAttached, missing }),
  };
}

/**
 * Forces every criterion whose checks include a render check to `unverified`, so
 * a criterion whose render check sent the reviewer no image can never pass on
 * that claim. The verification map records the forced status so the verdict's
 * own derivation cannot lift it back to a pass.
 */
export function forceUnverifiedRenderCriteria(input: {
  verdict: ReviewVerdict;
  renderCheckIds: readonly string[];
  criterionCheckIds: (criterionId: string) => readonly string[];
  verification: Map<string, 'pass' | 'fail' | 'unverified'>;
}): { verdict: ReviewVerdict; forcedCriterionIds: readonly string[] } {
  const render = new Set(input.renderCheckIds);
  const forcedCriterionIds: string[] = [];
  const criteria = input.verdict.criteria.map((criterion) => {
    if (!input.criterionCheckIds(criterion.id).some((checkId) => render.has(checkId))) {
      return criterion;
    }
    forcedCriterionIds.push(criterion.id);
    input.verification.set(verificationKey('criterion', criterion.id), 'unverified');
    return { ...criterion, status: 'unverified' as const };
  });
  return { verdict: { ...input.verdict, criteria }, forcedCriterionIds };
}
