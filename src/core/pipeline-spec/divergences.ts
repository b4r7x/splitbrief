/**
 * The behaviours `.nuke/2026-09-12-225752-recon-loop-granularity/recon-parity.md` §4 marks as
 * divergent between the CLI orchestrator and the `skills/` pipeline, with the side that changes.
 * `owner` names who moves: `cli` the orchestrator adopts the skill's rule, `skill` the rendered
 * skill text adopts the CLI's, `both` each side moves to a shared value, `intentional` the
 * divergence stays and is documented (REQ-042, the only such row).
 *
 * §4's own count line says 14 while the table prints 18 `no` rows; the 14 rows here are the
 * decided set: default mode and where the implementer writes are one intentional divergence
 * (REQ-042 states them in one sentence), and brief transport, standard-mode artifacts and
 * approval pauses are out of scope for this sprint (no CLI run-dir mode; the artifact set follows
 * the transport; the approval grammar is a UI decision, not a parity one).
 */
export type DivergenceOwner = 'cli' | 'skill' | 'both' | 'intentional';

export type Divergence = {
  readonly behaviour: string;
  readonly owner: DivergenceOwner;
  readonly req: string;
};

export const DIVERGENCE_TABLE: readonly Divergence[] = [
  { behaviour: 'Body section order / Current Code', owner: 'skill', req: 'REQ-039' },
  { behaviour: 'Retry framing keying', owner: 'skill', req: 'REQ-041' },
  { behaviour: 'Local retries default', owner: 'cli', req: 'REQ-033' },
  { behaviour: 'Ladder shape', owner: 'cli', req: 'REQ-044' },
  { behaviour: 'Hint composition sent to implementer', owner: 'skill', req: 'REQ-040' },
  { behaviour: 'Timeout policy', owner: 'both', req: 'REQ-037' },
  { behaviour: 'Drift per attempt', owner: 'cli', req: 'REQ-034' },
  { behaviour: 'Drift at review', owner: 'cli', req: 'REQ-035' },
  { behaviour: 'Recorded Validation Output body', owner: 'both', req: 'REQ-092' },
  { behaviour: 'Action on verdict', owner: 'cli', req: 'REQ-078' },
  {
    behaviour: 'Default mode and where the implementer writes',
    owner: 'intentional',
    req: 'REQ-042',
  },
  { behaviour: 'Mode upgrade thresholds', owner: 'cli', req: 'REQ-028' },
  { behaviour: 'Exhausted brief', owner: 'both', req: 'REQ-072' },
  { behaviour: 'Waiting for the implementer', owner: 'skill', req: 'REQ-046' },
];
