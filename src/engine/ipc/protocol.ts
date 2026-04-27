import type { EngineEvent } from '../events/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';

export type ServerMessage =
  | { kind: 'session_meta'; sessionId: string; startedAt: number; mode: WorkflowMode; feature: string; readonly: boolean }
  | { kind: 'event'; payload: EngineEvent }
  | { kind: 'replay_meta'; totalEvents: number; firstTs: number | null; lastTs: number | null }
  | { kind: 'error'; code: 'already_attached'; message: string };

export type ClientMessage =
  | { kind: 'user_input'; text: string }
  | { kind: 'detach' };

export const IPC_PROTOCOL_VERSION = 1;
