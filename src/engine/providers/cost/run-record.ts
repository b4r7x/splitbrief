import { parseRunnerIdentityKey } from '../../../core/providers/catalog.js';
import type {
  BillingAttribution,
  ProviderRunMetadata,
  OfferingBillingPresentation,
} from '../../../core/schemas/cost.js';
import type { CostBreakdownOptions } from './types.js';
import type { ProviderCostEntry } from './math.js';
import { callRunnerKey } from './request-estimates.js';
import { deriveCallBilling } from './call-billing.js';
import {
  UNATTRIBUTED_BILLING,
  LEGACY_BILLING,
  resolveProviderRunMetadata,
  isCliRunnerIdentity,
  cliOfferingFromBilling,
  describeOfferingBillingPresentation,
} from './run-metadata.js';

function collectRunMetadataTools(opts: CostBreakdownOptions): string[] {
  if (opts.callEvidence !== undefined) {
    return [...new Set(opts.callEvidence.map(callRunnerKey).filter((tool) => tool !== undefined))];
  }
  const tools = new Set<string>([opts.plannerTool, opts.implementerTool]);
  if (opts.reviewerTool !== undefined) tools.add(opts.reviewerTool);
  for (const task of opts.taskBreakdowns ?? []) {
    if (task.tool !== undefined) tools.add(task.tool);
  }
  return [...tools];
}

/**
 * What the run's own invocations proved about a tool's billing. Attributions
 * are compared whole — posture, basis and evidence id together — so one tool
 * reached through two different channels does not collapse into one claim: two
 * proven attributions that differ leave the tool unknown rather than letting
 * either of them stand for the run.
 */
function collectBillingEvidence(
  opts: CostBreakdownOptions,
  tools: readonly string[],
): Map<string, BillingAttribution> {
  const named = new Set(tools);
  const proven = new Map<string, BillingAttribution[]>();

  for (const call of opts.callEvidence ?? []) {
    const tool = callRunnerKey(call);
    if (tool === undefined || !named.has(tool)) continue;
    const attribution = deriveCallBilling(call.invocationIdentity);
    const attributions = proven.get(tool) ?? [];
    if (!attributions.some((entry) => sameAttribution(entry, attribution))) {
      attributions.push(attribution);
    }
    proven.set(tool, attributions);
  }

  const evidence = new Map<string, BillingAttribution>();
  for (const [tool, attributions] of proven) {
    const [single] = attributions;
    evidence.set(tool, attributions.length === 1 && single ? single : UNATTRIBUTED_BILLING);
  }
  return evidence;
}

function sameAttribution(left: BillingAttribution, right: BillingAttribution): boolean {
  return (
    left.posture === right.posture &&
    left.basis === right.basis &&
    left.evidenceId === right.evidenceId
  );
}

export function buildProviderRunMetadataRecord(
  opts: CostBreakdownOptions,
  providerCosts: Record<string, ProviderCostEntry> | undefined,
): {
  providerRunMetadata: Record<string, ProviderRunMetadata>;
  offeringPresentations: Record<string, OfferingBillingPresentation>;
} {
  const providerRunMetadata: Record<string, ProviderRunMetadata> = {};
  const offeringPresentations: Record<string, OfferingBillingPresentation> = {};
  const tools = collectRunMetadataTools(opts);
  const billingEvidence = collectBillingEvidence(opts, tools);
  // A run that recorded no call identities at all carries no provenance to read,
  // which is what a record written before any of it was captured looks like.
  const unproven = opts.callEvidence === undefined ? LEGACY_BILLING : UNATTRIBUTED_BILLING;

  for (const tool of tools) {
    const { kind, id } = parseRunnerIdentityKey(tool);
    const descriptor = resolveProviderRunMetadata({ tool: id, kind });
    if (descriptor === undefined) continue;
    const attribution = billingEvidence.get(tool);
    // Proof from the run's own invocations outranks the tool's catalogued
    // default, in both directions: an enforced api-key invocation is billed as
    // what it was, and channels that disagree are billed as unknown. A CLI
    // offering is a function of its billing, so it follows; there is no unknown
    // offering to move to, and payg's label reports the estimate or the word
    // `unknown` rather than claiming a subscription paid for the run.
    const billing = attribution === undefined ? descriptor.billing : attribution.posture;
    const metadata: ProviderRunMetadata = {
      ...descriptor,
      billing,
      ...(attribution !== undefined &&
        isCliRunnerIdentity(kind, id) && { offering: cliOfferingFromBilling(billing) }),
      billingAttribution: attribution ?? unproven,
    };
    providerRunMetadata[tool] = metadata;
    const usageEntry = providerCosts?.[tool];
    const usageTokens =
      (usageEntry?.inputTokens ?? 0) +
      (usageEntry?.outputTokens ?? 0) +
      (usageEntry?.cacheReadTokens ?? 0) +
      (usageEntry?.cacheCreateTokens ?? 0);
    offeringPresentations[tool] = describeOfferingBillingPresentation(metadata, {
      hasUsage: usageTokens > 0,
      meteredCost: usageEntry?.cost ?? 0,
    });
  }

  return { providerRunMetadata, offeringPresentations };
}
