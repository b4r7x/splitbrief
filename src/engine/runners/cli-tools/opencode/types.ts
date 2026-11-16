import type { SteerOutcome } from '../../../calls/steering.js';

export type SidecarServer = Readonly<{ url: string; password: string }>;

/** The session of the tool that a steer goes to, on the sidecar of the call. */
export type SteerTarget = Readonly<{
  url: string;
  headers: Record<string, string>;
  sessionId: string;
}>;

/** A steer that the call admitted and that waits for its outcome. */
export type PendingSteer = { sent: boolean; resolve: (outcome: SteerOutcome) => void };

/** One steered OpenCode call: what its sidecar steps and its steer steps read, and its state. */
export type SteeringCall = Readonly<{
  ready: PromiseWithResolvers<SidecarServer>;
  /** Stops the sidecar: the close and the startup timeout abort it. */
  stopController: AbortController;
  /** Aborts with the cause when the sidecar fails during the call. */
  failureController: AbortController;
  /** Aborts the requests to the sidecar when the admission closes. */
  requestsController: AbortController;
  /** The stop of the sidecar or the caller's signal. */
  sidecarSignal: AbortSignal;
  pending: Set<PendingSteer>;
  /** The posts and the inbox reads that the close waits for. */
  work: Set<Promise<void>>;
  state: {
    /** The first close of the admission clears it; a steer after it is deferred. */
    accepting: boolean;
    /** The chain that posts the admitted steers one after the other. */
    admissions: Promise<void>;
  };
}>;
