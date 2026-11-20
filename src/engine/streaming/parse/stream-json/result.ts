import type {
  ParsedTextChannel,
  ParsedTextSemantics,
  ToolUseInfo,
  ToolUseDeltaInfo,
  ParsedWarningInfo,
} from '../../../runners/types.js';

export interface StreamParseResult {
  text?: string | undefined;
  inputAck?: string | undefined;
  channel?: ParsedTextChannel | undefined;
  /** `final` closes an assistant record; its text, when present, restates streamed deltas. */
  textSemantics?: ParsedTextSemantics | undefined;
  sessionId?: string | undefined;
  isResult?: boolean | undefined;
  isSessionInit?: boolean | undefined;
  /** The model id an `init` frame reports: what the seat's model alias resolved to. */
  resolvedModel?: string | undefined;
  isError?: boolean | undefined;
  /** Tools a `user` record's `tool_result` closed: the tool ran and answered. */
  toolUse?: ToolUseInfo[] | undefined;
  /** Tools an `assistant` record gave their whole input; each stays open until its result. */
  toolUseInput?: ToolUseInfo[] | undefined;
  toolUseStart?: ToolUseInfo[] | undefined;
  toolUseDelta?: ToolUseDeltaInfo[] | undefined;
  warning?: ParsedWarningInfo[] | undefined;
  /** A string `parent_tool_use_id`: the subagent id of the record, not the main loop. */
  subagentId?: string | undefined;
  /** A `message_start` opened a message. */
  isMessageStart?: boolean | undefined;
  /** `message_delta.delta.stop_reason`: why the open message ended. */
  stopReason?: string | undefined;
  /** A frame that says nothing to the operator and only proves the CLI is still working. */
  isHeartbeat?: boolean | undefined;
  /** The result record's `structured_output`, when the call ran with `--json-schema`. */
  structured?: unknown;
}

export const EMPTY_RESULT: StreamParseResult = Object.freeze({});

/** The open tools by `tool_use_id`, so a `tool_result` closes a tool with its name and input. */
export type OpenTools = Map<string, ToolUseInfo>;
