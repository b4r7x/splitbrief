const DEFAULT_DELAY_MS = 35;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;

// Ink 6.8 parses input chunks synchronously with no buffering, so over a slow
// link a single arrow key (`\x1b` then `[A`) can read as a lone ESC followed by
// the rest of the sequence. Deferring the ESC-triggered action by a few
// milliseconds lets the trailing bytes cancel it before it fires.
export function scheduleEscapeAction(action: () => void): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    action();
  }, DEFAULT_DELAY_MS);
}

export function cancelEscapeAction(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

export function isEscapeActionPending(): boolean {
  return pendingTimer !== null;
}
