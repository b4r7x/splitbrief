import type { RunnerCallEvent } from './types.js';

export function isRunnerCallTerminalEvent(event: RunnerCallEvent): boolean {
  return event.type === 'call_completed' || event.type === 'call_error';
}
