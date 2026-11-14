import { formatCost } from '../../../core/formatting.js';
import { billingWord } from '../../../core/runners/runner-billing.js';
import { runnerKeyLabel } from './derive.js';
import type { UsageRateRow, UsageBillingRow, UsageDetailsView } from './types.js';
import {
  RATE_SOURCE_WORDS,
  formatUsageTokens,
  BASIS_WORDS,
  type UsageDetailRow,
  type UsageTone,
  COUNTER_LABELS,
  formatUsageAmount,
  formatUsageMoney,
  statesAmount,
  AMOUNT_BASIS_WORDS,
  REASON_WORDS,
} from './format.js';
import {
  type RecoveryContextBudgetSource,
  type RecoveryContextOmittedOption,
  type RecoveryContextDetails,
  recoveryContextSeatLabel,
  recoveryContextCauseWords,
} from './recovery-context.js';

/** An unpriced snapshot keeps zero placeholders; its source word is the whole rate. */
function rateFacts(row: UsageRateRow): string[] {
  const { rates } = row;
  const requests = row.requests === 1 ? '1 request' : `${row.requests} requests`;
  if (rates.source === 'unpriced') return [rates.model, RATE_SOURCE_WORDS.unpriced, requests];
  const facts = [
    rates.model,
    RATE_SOURCE_WORDS[rates.source],
    `in ${formatCost(rates.inputPer1M)}/M`,
    `out ${formatCost(rates.outputPer1M)}/M`,
  ];
  if (rates.selectedThresholdTokens !== undefined) {
    facts.push(`tier ${formatUsageTokens(rates.selectedThresholdTokens)}`);
  }
  facts.push(rates.rateAsOf === undefined ? 'no rate date' : `rates of ${rates.rateAsOf}`);
  facts.push(requests);
  return facts;
}

function billingFacts(row: UsageBillingRow): string[] {
  const posture = billingWord(row.posture) ?? 'unknown';
  return [posture, row.proven ? BASIS_WORDS[row.basis] : `${BASIS_WORDS[row.basis]}, tool default`];
}

const ESTIMATE_NOTE = 'Catalog estimate from the rates below, not a confirmed amount.';
const LEGACY_NOTE = 'Recorded before per-request pricing; no rates were kept with it.';
const CONTEXT_NOTE = ['Nothing was sent to the seat', 'measured while the call was assembled'];
const NOT_MEASURED = 'not measured';
const NOT_RECORDED = 'not recorded';
const BUDGET_SOURCE_WORDS: Readonly<Record<RecoveryContextBudgetSource, string>> = {
  configured: 'configured limit',
  'observed-active': 'active provider limit',
  'application-default': 'application default',
};
const OMITTED_OPTION_WORDS: Readonly<Record<RecoveryContextOmittedOption, string>> = {
  temperature: 'temperature',
  reasoning_effort: 'reasoning effort',
  'stream_options.include_usage': 'stream usage',
};

function header(key: string, label: string, first = false): UsageDetailRow[] {
  const heading: UsageDetailRow = { key, kind: 'header', label, facts: [], tone: 'textDim' };
  if (first) return [heading];
  return [{ key: `${key}:gap`, kind: 'spacer', label: '', facts: [], tone: 'textDim' }, heading];
}

function entry(key: string, label: string, facts: string[], tone: UsageTone): UsageDetailRow {
  return { key, kind: 'entry', label, facts, tone };
}

/** `140,000` reads as a count only next to what it counts; the head figure carries the unit. */
function tokenFact(label: string, tokens: number | null): string | null {
  return tokens === null ? null : `${label} ${formatUsageTokens(tokens)}`;
}

function measuredFacts(head: number | null, tail: ReadonlyArray<string | null>): string[] {
  const facts = [head === null ? null : `${formatUsageTokens(head)} tokens`, ...tail].filter(
    (fact): fact is string => fact !== null,
  );
  return facts.length === 0 ? [NOT_MEASURED] : facts;
}

/**
 * What the halt measured, in the order it is read: which seat refused and why, what it was never
 * given, then the two figures the refusal compared. A measurement nobody took says so.
 */
function contextRows(context: RecoveryContextDetails | null): UsageDetailRow[] {
  if (context === null) return [];
  const needed = measuredFacts(context.requiredTokens, [
    tokenFact('input', context.inputEstimate),
    tokenFact('margin', context.estimationMargin),
    tokenFact('output reserve', context.requiredOutputTokens),
  ]);
  const available = measuredFacts(context.availableTokens, [
    tokenFact('output cap', context.outputCap),
  ]);
  const rows: UsageDetailRow[] = [
    ...header('context', 'Context', true),
    entry('context:seat', 'Seat', [recoveryContextSeatLabel(context)], 'text'),
    entry(
      'context:model',
      'Model',
      [context.model ?? NOT_RECORDED],
      context.model === null ? 'textDim' : 'text',
    ),
    entry('context:cause', 'Cause', [recoveryContextCauseWords(context)], 'warning'),
  ];
  if (context.missingSections === null) {
    rows.push(entry('context:missing', 'Missing', [NOT_RECORDED], 'textDim'));
  } else if (context.missingSections.length > 0) {
    rows.push(entry('context:missing', 'Missing', [...context.missingSections], 'text'));
  }
  rows.push(
    entry('context:needed', 'Needed', needed, needed[0] === NOT_MEASURED ? 'textDim' : 'text'),
    entry(
      'context:available',
      'Available',
      available,
      available[0] === NOT_MEASURED ? 'textDim' : 'text',
    ),
  );
  if (context.budgetSource !== null) {
    rows.push(
      entry(
        'context:budget-source',
        'Limit source',
        [BUDGET_SOURCE_WORDS[context.budgetSource]],
        'text',
      ),
    );
  }
  if (context.omittedRequestOptions !== null) {
    rows.push(
      entry(
        'context:omitted-options',
        'Omitted options',
        context.omittedRequestOptions.length === 0
          ? ['none']
          : context.omittedRequestOptions.map((option) => OMITTED_OPTION_WORDS[option]),
        context.omittedRequestOptions.length === 0 ? 'textDim' : 'text',
      ),
    );
  }
  rows.push({ key: 'context:note', kind: 'note', label: '', facts: CONTEXT_NOTE, tone: 'textDim' });
  return rows;
}

/** The rows the view paints, in reading order. One fact per row; absence is a word, never a zero. */
export function usageDetailRows(view: UsageDetailsView): UsageDetailRow[] {
  if (view.empty) {
    return [
      { key: 'empty', kind: 'note', label: '', facts: ['No usage recorded'], tone: 'textDim' },
    ];
  }
  const rows: UsageDetailRow[] = [...contextRows(view.context)];
  rows.push(...header('tokens', 'Tokens', rows.length === 0));
  for (const row of view.counters) {
    rows.push(
      entry(
        `counter:${row.counter}`,
        COUNTER_LABELS[row.counter],
        [formatUsageAmount(row.amount)],
        row.amount.kind === 'reported' ? 'text' : 'textDim',
      ),
    );
  }

  rows.push(...header('money', 'Money'));
  rows.push(
    entry(
      'money:amount',
      'Amount',
      [formatUsageMoney(view.money)],
      statesAmount(view.money) ? 'text' : 'textDim',
    ),
  );
  // A run with no amount has no basis to state: `unmetered` carries its billing words instead, and
  // `not estimated` is the absence itself.
  if (
    (view.money.kind === 'estimate' || view.money.kind === 'legacy') &&
    statesAmount(view.money)
  ) {
    rows.push(
      entry(
        'money:basis',
        'Basis',
        [AMOUNT_BASIS_WORDS[view.basis]],
        view.basis === 'catalog-estimate' ? 'text' : 'textDim',
      ),
    );
  }
  if (view.money.kind === 'estimate' && view.money.completeness !== 'complete') {
    rows.push(
      entry(
        'money:reasons',
        'Incomplete',
        view.money.reasons.map((reason) => REASON_WORDS[reason]),
        'text',
      ),
    );
  }
  if (
    (view.money.kind === 'estimate' || view.money.kind === 'legacy') &&
    statesAmount(view.money)
  ) {
    rows.push({
      key: 'money:note',
      kind: 'note',
      label: '',
      facts: [view.money.kind === 'legacy' ? LEGACY_NOTE : ESTIMATE_NOTE],
      tone: 'textDim',
    });
  }

  rows.push(...header('rates', 'Rates'));
  if (view.rates.length === 0) {
    rows.push(entry('rates:none', 'Source', ['not recorded'], 'textDim'));
  }
  for (const [index, row] of view.rates.entries()) {
    rows.push(entry(`rates:${index}`, runnerKeyLabel(row.rates.provider), rateFacts(row), 'text'));
  }

  rows.push(...header('billing', 'Billing'));
  if (view.billing.length === 0) {
    rows.push(entry('billing:none', 'Channel', ['not recorded'], 'textDim'));
  }
  for (const row of view.billing) {
    rows.push(
      entry(`billing:${row.key}`, row.tool, billingFacts(row), row.proven ? 'text' : 'textDim'),
    );
  }
  return rows;
}
