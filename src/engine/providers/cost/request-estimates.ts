import type { RunnerCallCounterCoverage } from '../../../core/runner-call-contract.js';
import type {
  BillingAttribution,
  RateSnapshot,
  RequestEstimate,
  RequestEstimateItem,
  RequestEstimateReason,
} from '../../../core/schemas/summary.js';
import type { InvocationIdentity } from '../../../core/schemas/invocation-identity.js';
import type { CallUsageEvidence } from '../../../core/schemas/usage-evidence.js';
import { selectPricingForContext } from '../cost-math.js';
import { resolvePricing, type ResolvedPricing } from '../pricing-resolver.js';
import type { ModelCacheAccessor } from '../model/resolution.js';

/**
 * Rates for one recorded call. A function lets a run that used several models
 * price each request against the rates of the model that served it.
 */
export type RequestEstimatePricing =
  | ResolvedPricing
  | ((call: CallUsageEvidence) => ResolvedPricing | undefined);

type PricedCategory = { tokens: number; rate: number | undefined };

export function callRunnerName(call: CallUsageEvidence): string | undefined {
  return call.invocationIdentity?.runner.id ?? call.runnerName;
}

export function resolveCallPricing(
  call: CallUsageEvidence,
  cache: ModelCacheAccessor | undefined,
): ResolvedPricing | undefined {
  const runner = callRunnerName(call);
  const model = call.invocationIdentity?.model ?? call.model;
  return runner === undefined || model === undefined
    ? undefined
    : resolvePricing(runner, cache, model);
}

/**
 * Prices every recorded call as its own provider request and adds the results
 * up. A context tier is chosen from one request's own input total, so two small
 * requests never combine into one large-context request; a call whose usage
 * covers more than one request cannot answer that question at all and is
 * reported unavailable rather than priced at a tier it may not have paid.
 *
 * The sum carries an `amount` only when every request it covers is complete.
 * `knownSubtotal` is what could be priced regardless, because an unknown rate
 * or counter is unknown, not zero.
 */
export function sumRequestEstimates(
  evidence: readonly CallUsageEvidence[],
  pricing: RequestEstimatePricing,
  capturedAt: number = Date.now(),
): RequestEstimate {
  const items = evidence.map((call) =>
    estimateRequest(call, resolveFor(pricing, call), capturedAt),
  );
  const knownSubtotal = items.reduce((total, item) => total + item.knownSubtotal, 0);
  const priceable = items.filter((item) => item.completeness !== 'unavailable');
  const completeness =
    priceable.length === 0
      ? 'unavailable'
      : priceable.length === items.length && items.every((item) => item.amount !== null)
        ? 'complete'
        : 'partial';
  const amount =
    completeness === 'complete'
      ? items.reduce((total, item) => total + (item.amount ?? 0), 0)
      : null;

  return {
    amount,
    currency: 'USD',
    basis: completeness === 'unavailable' ? 'unavailable' : 'catalog-estimate',
    completeness,
    knownSubtotal,
    reasons: collectReasons(items.flatMap((item) => item.reasons)),
    items,
  };
}

function resolveFor(
  pricing: RequestEstimatePricing,
  call: CallUsageEvidence,
): ResolvedPricing | undefined {
  return typeof pricing === 'function' ? pricing(call) : pricing;
}

function estimateRequest(
  call: CallUsageEvidence,
  pricing: ResolvedPricing | undefined,
  capturedAt: number,
): RequestEstimateItem {
  const usage = call.usage;
  const rates = pricing === undefined ? undefined : rateSnapshot(pricing, undefined, capturedAt);
  if (usage === null) return unavailable(call, ['usage-not-reported'], rates);
  if (pricing === undefined || !pricing.isPriced) {
    return unavailable(call, ['unpriced-model'], rates);
  }

  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheCreateTokens = usage.cacheCreateTokens ?? 0;
  const contextTokens =
    usage.providerTotals?.input ?? usage.inputTokens + cacheReadTokens + cacheCreateTokens;
  const contextTokensKnown =
    usage.providerTotals?.input !== undefined ||
    (reported(usage.counterCoverage, 'input') &&
      reported(usage.counterCoverage, 'cacheRead') &&
      reported(usage.counterCoverage, 'cacheCreate'));

  if (hasContextTiers(pricing)) {
    if (call.usageBoundary !== 'single-request') {
      return unavailable(
        call,
        [call.usageBoundary === 'aggregate' ? 'aggregate-boundary' : 'unknown-boundary'],
        rates,
      );
    }
    if (!contextTokensKnown) return unavailable(call, ['unknown-context-total'], rates);
  }

  const selected = selectPricingForContext(pricing, contextTokens);
  const selectedRates = rateSnapshot(
    selected,
    selectedThreshold(pricing, contextTokens),
    capturedAt,
  );
  const categories: Record<'input' | 'cacheRead' | 'cacheCreate', PricedCategory> = {
    input: { tokens: usage.inputTokens, rate: selected.inputPer1M },
    cacheRead: { tokens: cacheReadTokens, rate: selected.cacheReadPer1M },
    cacheCreate: { tokens: cacheCreateTokens, rate: selected.cacheWritePer1M },
  };

  const reasons: RequestEstimateReason[] = [];
  let knownSubtotal = 0;
  let complete = true;
  let knownInputTokens = 0;
  const unknownInputRates: Array<number | undefined> = [];
  for (const name of ['input', 'cacheRead', 'cacheCreate'] as const) {
    const category = categories[name];
    if (!reported(usage.counterCoverage, name)) {
      unknownInputRates.push(category.rate);
      continue;
    }
    knownInputTokens += category.tokens;
    if (category.tokens <= 0) continue;
    if (category.rate === undefined) {
      complete = false;
      reasons.push('missing-cache-rate');
      continue;
    }
    knownSubtotal += perMillion(category.tokens, category.rate);
  }

  // An inclusive total can price an unknown split only when every possible
  // allocation costs the same. Without that total, equal rates prove no count.
  if (unknownInputRates.length > 0) {
    const total = usage.providerTotals?.input;
    const remaining = total === undefined ? undefined : total - knownInputTokens;
    const [rate] = unknownInputRates;
    if (
      remaining !== undefined &&
      remaining >= 0 &&
      (remaining === 0 ||
        (rate !== undefined && unknownInputRates.every((candidate) => candidate === rate)))
    ) {
      knownSubtotal += perMillion(remaining, rate ?? 0);
    } else {
      complete = false;
      reasons.push(
        total === undefined && !reported(usage.counterCoverage, 'input')
          ? 'unknown-input-count'
          : 'unknown-category-split',
      );
    }
  }

  // One output rate covers the whole generation, so the provider's inclusive
  // output total prices it even when the reasoning part of it was never broken
  // out — and using that total is also what keeps reasoning from being added,
  // and billed, a second time.
  const generatedTokens =
    usage.providerTotals?.output ?? usage.outputTokens + (usage.reasoningTokens ?? 0);
  if (generatedTokensKnown(usage)) {
    knownSubtotal += perMillion(generatedTokens, selected.outputPer1M);
  } else {
    const reportedOutput = reported(usage.counterCoverage, 'output') ? usage.outputTokens : 0;
    const reportedReasoning = reported(usage.counterCoverage, 'reasoning')
      ? (usage.reasoningTokens ?? 0)
      : 0;
    knownSubtotal += perMillion(reportedOutput + reportedReasoning, selected.outputPer1M);
    complete = false;
    reasons.push('unknown-output-count');
  }
  if (!reported(usage.counterCoverage, 'reasoning')) reasons.push('reasoning-not-reported');

  return {
    ...identity(call),
    amount: complete ? knownSubtotal : null,
    knownSubtotal,
    completeness: complete ? 'complete' : 'partial',
    reasons: collectReasons(reasons),
    rates: selectedRates,
  };
}

/**
 * The rates as they were used, so the record answers "what was this priced at"
 * on its own. The lookup time is recorded as a lookup time; a rate date is
 * copied only from a source that publishes one.
 */
function rateSnapshot(
  pricing: ResolvedPricing,
  selectedThresholdTokens: number | undefined,
  capturedAt: number,
): RateSnapshot {
  return {
    source: pricing.source,
    provider: pricing.provider,
    model: pricing.name,
    inputPer1M: pricing.inputPer1M,
    outputPer1M: pricing.outputPer1M,
    ...(pricing.cacheReadPer1M !== undefined && { cacheReadPer1M: pricing.cacheReadPer1M }),
    ...(pricing.cacheWritePer1M !== undefined && { cacheWritePer1M: pricing.cacheWritePer1M }),
    ...(selectedThresholdTokens !== undefined && { selectedThresholdTokens }),
    capturedAt,
    ...(pricing.rateAsOf !== undefined && { rateAsOf: pricing.rateAsOf }),
  };
}

/** The context tier `selectPricingForContext` priced this request at, if any. */
function selectedThreshold(pricing: ResolvedPricing, contextTokens: number): number | undefined {
  let threshold: number | undefined;
  for (const tier of pricing.pricingTiers ?? []) {
    if (tier.type !== 'context' || tier.thresholdTokens > contextTokens) continue;
    if (threshold === undefined || tier.thresholdTokens > threshold)
      threshold = tier.thresholdTokens;
  }
  return threshold;
}

const UNKNOWN_BILLING: BillingAttribution = { posture: 'unknown', basis: 'unknown' };

/**
 * Who paid for one call, read from the identity the invocation recorded and
 * from nothing else — a configured preference is not a method, and a tool's
 * catalogued default is not evidence about this call. `InvocationIdentitySchema`
 * is where a basis becomes proof: it already refuses one whose channels
 * disagree, whose evidence id does not match the channel it names, or that
 * claims a subscription covered an api-key invocation. So a proven basis here is
 * proven, and everything else — no identity, no evidence, a channel nobody
 * enforced — is unknown.
 */
export function deriveCallBilling(identity: InvocationIdentity | undefined): BillingAttribution {
  const billing = identity?.billing;
  if (billing === undefined || billing.basis === 'unknown') return UNKNOWN_BILLING;
  return {
    posture: billing.posture,
    basis: billing.basis,
    ...(billing.evidenceId !== undefined && { evidenceId: billing.evidenceId }),
  };
}

function generatedTokensKnown(usage: NonNullable<CallUsageEvidence['usage']>): boolean {
  if (usage.providerTotals?.output !== undefined) return true;
  return reported(usage.counterCoverage, 'output') && reported(usage.counterCoverage, 'reasoning');
}

function hasContextTiers(pricing: ResolvedPricing): boolean {
  return (pricing.pricingTiers ?? []).some((tier) => tier.type === 'context');
}

// A record carrying no coverage at all describes nothing; it is unknown, which
// is what a legacy total is.
function reported(
  coverage: RunnerCallCounterCoverage | undefined,
  category: keyof RunnerCallCounterCoverage,
): boolean {
  return coverage?.[category] === 'reported';
}

function perMillion(tokens: number, ratePer1M: number): number {
  return (tokens / 1_000_000) * ratePer1M;
}

function unavailable(
  call: CallUsageEvidence,
  reasons: RequestEstimateReason[],
  rates: RateSnapshot | undefined,
): RequestEstimateItem {
  return {
    ...identity(call),
    amount: null,
    knownSubtotal: 0,
    completeness: 'unavailable',
    reasons,
    ...(rates !== undefined && { rates }),
  };
}

function identity(
  call: CallUsageEvidence,
): Pick<
  RequestEstimateItem,
  | 'callId'
  | 'taskId'
  | 'attempt'
  | 'role'
  | 'model'
  | 'usageBoundary'
  | 'billing'
  | 'invocationIdentity'
> {
  return {
    callId: call.callId,
    ...(call.taskId !== undefined && { taskId: call.taskId }),
    ...(call.attempt !== undefined && { attempt: call.attempt }),
    role: call.role,
    ...((call.invocationIdentity?.model ?? call.model) !== undefined && {
      model: call.invocationIdentity?.model ?? call.model,
    }),
    usageBoundary: call.usageBoundary,
    billing: deriveCallBilling(call.invocationIdentity),
    ...(call.invocationIdentity !== undefined && {
      invocationIdentity: call.invocationIdentity,
    }),
  };
}

function collectReasons(reasons: readonly RequestEstimateReason[]): RequestEstimateReason[] {
  return [...new Set(reasons)];
}
