import type { z } from 'zod';
import type { Failure } from './failures.js';
import { appendMapValue } from './multimap.js';
import { captureAccountingKey, hasMatchingProvenance, type CaptureSelection } from './selection.js';

export function validateRequestResolutions(options: {
  readonly selection: CaptureSelection;
  readonly failures: readonly Failure[];
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { selection, failures, context } = options;
  const requests = new Map(
    selection.requests.map((request, index) => [
      captureAccountingKey(request.provenance),
      { index, request },
    ]),
  );
  const resolutions = new Map<string, string[]>();

  for (const target of selection.targets) {
    addResolution({
      resolutions,
      requestKey: captureAccountingKey(target.provenance),
      resolution: 'capture target',
    });
  }

  for (const [index, failure] of failures.entries()) {
    if (failure.stage !== 'selection') continue;
    const requestKey = captureAccountingKey(failure.target.provenance);
    const selected = requests.get(requestKey);
    if (
      !selected ||
      !hasMatchingProvenance({
        left: selected.request.provenance,
        right: failure.target.provenance,
      })
    ) {
      context.addIssue({
        code: 'custom',
        message: 'selection failure does not match an explicit capture request',
        path: ['failures', index, 'target'],
      });
      continue;
    }
    addResolution({ resolutions, requestKey, resolution: 'selection failure' });
  }

  for (const [requestKey, selected] of requests) {
    const outcomes = resolutions.get(requestKey) ?? [];
    if (outcomes.length === 0) {
      context.addIssue({
        code: 'custom',
        message: `capture request has no target or structured selection failure: ${requestKey}`,
        path: ['selection', 'requests', selected.index],
      });
    }
    if (outcomes.length > 1) {
      context.addIssue({
        code: 'custom',
        message: `capture request has contradictory resolutions: ${outcomes.join(', ')}`,
        path: ['selection', 'requests', selected.index],
      });
    }
  }
}

function addResolution(options: {
  readonly resolutions: Map<string, string[]>;
  readonly requestKey: string;
  readonly resolution: string;
}): void {
  appendMapValue({
    map: options.resolutions,
    key: options.requestKey,
    value: options.resolution,
  });
}
