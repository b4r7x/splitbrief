declare module '@anthropic-ai/claude-agent-sdk' {
  export interface QueryMessage {
    type: string;
    subtype?: string;
    session_id?: string;
    message?: {
      content?: Array<{ type: string; text?: string }>;
    };
    result?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  }

  export interface QueryParams {
    prompt: string;
    options: {
      allowedTools: string[];
      permissionMode: string;
      model: string;
      cwd: string;
      resume?: string | undefined;
      env?: Record<string, string | undefined>;
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined;
      abortController?: AbortController | undefined;
    };
  }

  export function query(opts: QueryParams): AsyncIterable<QueryMessage>;
}
