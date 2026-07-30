export const LIGHTHOUSE_RUNS_PER_ROUTE = 3;

export const LIGHTHOUSE_ROUTES = [
  '/',
  '/docs/getting-started/introduction',
  '/docs/concepts/task-briefs',
  '/docs/guides/cookbook',
  '/docs/reference/cli',
  '/docs/project/roadmap',
] as const;

export const LIGHTHOUSE_REPORT_DIRECTORY = '.lighthouseci/reports';

type LighthouseScore = {
  readonly numericValue?: number;
  readonly score: number | null;
};

export type LighthouseMeasurement = {
  readonly audits: Readonly<Record<string, LighthouseScore | undefined>>;
  readonly categories: Readonly<Record<string, LighthouseScore | undefined>>;
};

type AssertionSource =
  | {
      readonly id: string;
      readonly kind: 'audit-numeric-value' | 'audit-score';
    }
  | {
      readonly id: string;
      readonly kind: 'category-score';
    };

type AssertionBase = {
  readonly aggregation: 'median' | 'pessimistic';
  readonly label: string;
  readonly source: AssertionSource;
};

export type LighthouseAssertion =
  | (AssertionBase & { readonly maximum: number })
  | (AssertionBase & { readonly minimum: number });

export const LIGHTHOUSE_ASSERTIONS: readonly LighthouseAssertion[] = [
  {
    aggregation: 'median',
    label: 'Performance',
    minimum: 0.9,
    source: { id: 'performance', kind: 'category-score' },
  },
  {
    aggregation: 'pessimistic',
    label: 'Accessibility',
    minimum: 1,
    source: { id: 'accessibility', kind: 'category-score' },
  },
  {
    aggregation: 'median',
    label: 'First Contentful Paint',
    maximum: 2_000,
    source: { id: 'first-contentful-paint', kind: 'audit-numeric-value' },
  },
  {
    aggregation: 'median',
    label: 'Largest Contentful Paint',
    maximum: 2_500,
    source: { id: 'largest-contentful-paint', kind: 'audit-numeric-value' },
  },
  {
    aggregation: 'median',
    label: 'Cumulative Layout Shift',
    maximum: 0.1,
    source: { id: 'cumulative-layout-shift', kind: 'audit-numeric-value' },
  },
  {
    aggregation: 'median',
    label: 'Total Blocking Time',
    maximum: 300,
    source: { id: 'total-blocking-time', kind: 'audit-numeric-value' },
  },
  {
    aggregation: 'pessimistic',
    label: 'Color contrast',
    minimum: 1,
    source: { id: 'color-contrast', kind: 'audit-score' },
  },
  {
    aggregation: 'pessimistic',
    label: 'Heading order',
    minimum: 1,
    source: { id: 'heading-order', kind: 'audit-score' },
  },
  {
    aggregation: 'pessimistic',
    label: 'Console errors',
    minimum: 1,
    source: { id: 'errors-in-console', kind: 'audit-score' },
  },
];

export type LighthouseAuditPlanItem = {
  readonly reportBasename: string;
  readonly route: (typeof LIGHTHOUSE_ROUTES)[number];
  readonly runNumber: number;
  readonly url: string;
};

function reportSlug(route: (typeof LIGHTHOUSE_ROUTES)[number]): string {
  return route === '/' ? 'home' : route.slice(1).replaceAll('/', '--');
}

export function lighthouseAuditPlan(origin: string): LighthouseAuditPlanItem[] {
  return LIGHTHOUSE_ROUTES.flatMap((route) =>
    Array.from({ length: LIGHTHOUSE_RUNS_PER_ROUTE }, (_, index) => {
      const runNumber = index + 1;
      return {
        reportBasename: `${reportSlug(route)}-run-${runNumber}`,
        route,
        runNumber,
        url: new URL(route, `${origin}/`).href,
      };
    }),
  );
}

function assertionValue(
  measurement: LighthouseMeasurement,
  assertion: LighthouseAssertion,
): number | undefined {
  const result =
    assertion.source.kind === 'category-score'
      ? measurement.categories[assertion.source.id]
      : measurement.audits[assertion.source.id];
  if (!result) {
    return undefined;
  }

  if (assertion.source.kind === 'audit-numeric-value') {
    return result.numericValue;
  }

  return result.score ?? undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);
  const upperMiddle = sorted[middleIndex];
  if (upperMiddle === undefined) {
    throw new Error('Cannot calculate a median without measurements');
  }
  if (sorted.length % 2 === 1) {
    return upperMiddle;
  }

  const lowerMiddle = sorted[middleIndex - 1];
  if (lowerMiddle === undefined) {
    throw new Error('Cannot calculate a median without a lower measurement');
  }
  return (lowerMiddle + upperMiddle) / 2;
}

function aggregate(values: readonly number[], assertion: LighthouseAssertion): number {
  if (assertion.aggregation === 'median') {
    return median(values);
  }

  return 'minimum' in assertion ? Math.min(...values) : Math.max(...values);
}

function formattedLimit(assertion: LighthouseAssertion): string {
  return 'minimum' in assertion ? `at least ${assertion.minimum}` : `at most ${assertion.maximum}`;
}

export function lighthouseAssertionViolations(
  route: string,
  measurements: readonly LighthouseMeasurement[],
): string[] {
  if (measurements.length !== LIGHTHOUSE_RUNS_PER_ROUTE) {
    return [
      `${route}: expected ${LIGHTHOUSE_RUNS_PER_ROUTE} Lighthouse runs, received ${measurements.length}`,
    ];
  }

  const violations: string[] = [];
  for (const assertion of LIGHTHOUSE_ASSERTIONS) {
    const values = measurements.map((measurement) => assertionValue(measurement, assertion));
    if (values.some((value) => value === undefined)) {
      violations.push(`${route}: ${assertion.label} has a missing or unscored result`);
      continue;
    }

    const numericValues = values.filter((value): value is number => value !== undefined);
    const aggregatedValue = aggregate(numericValues, assertion);
    const passes =
      'minimum' in assertion
        ? aggregatedValue >= assertion.minimum
        : aggregatedValue <= assertion.maximum;
    if (!passes) {
      violations.push(
        `${route}: ${assertion.label} ${assertion.aggregation} is ${aggregatedValue}; expected ${formattedLimit(assertion)}`,
      );
    }
  }

  return violations;
}
