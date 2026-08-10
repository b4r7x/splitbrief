import { describe, it, expect } from 'vitest';
import { parseOpencodeLine } from './parse-opencode.js';

describe('parseOpencodeLine', () => {
  it('returns empty for blank line', () => {
    expect(parseOpencodeLine('')).toEqual({});
    expect(parseOpencodeLine('   ')).toEqual({});
  });

  it('parses text part from the real envelope', () => {
    const event = {
      type: 'text',
      timestamp: 1781345484606,
      sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
      part: {
        id: 'prt_ec076ff1800121yroOznZEpT7r',
        sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
        messageID: 'msg_ec076de2d001eIfRD5tzzP0L6w',
        type: 'text',
        text: 'a.js, err.txt, out.txt\n\ndone',
        time: { start: 1781345484605, end: 1781345484605 },
      },
    };
    const result = parseOpencodeLine(JSON.stringify(event));
    expect(result.text).toBe('a.js, err.txt, out.txt\n\ndone');
    expect(result.channel).toBe('assistant');
    expect(result.sessionId).toBe('ses_13f89223effeq85h7RlKmjsV3M');
  });

  it('parses step_finish usage from part.tokens', () => {
    const event = {
      type: 'step_finish',
      timestamp: 1781345484609,
      sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
      part: {
        id: 'prt_ec076ff3f001seD4fnNJbMtL5k',
        sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
        messageID: 'msg_ec076de2d001eIfRD5tzzP0L6w',
        type: 'step-finish',
        reason: 'stop',
        cost: 0.1121604,
        tokens: {
          total: 64362,
          input: 64328,
          output: 34,
          reasoning: 32,
          cache: { read: 0, write: 0 },
        },
      },
    };
    const result = parseOpencodeLine(JSON.stringify(event));
    expect(result.usage).toEqual({
      inputTokens: 64328,
      outputTokens: 34,
      reasoningTokens: 32,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    expect(result.sessionId).toBe('ses_13f89223effeq85h7RlKmjsV3M');
  });

  it('returns a bounded warning for invalid JSON', () => {
    expect(parseOpencodeLine('broken')).toEqual({
      warning: [
        expect.objectContaining({
          code: 'malformed_opencode',
          source: 'opencode',
          parser: 'opencode',
          upstreamType: 'malformed_json',
          channel: 'stdout',
        }),
      ],
    });
  });

  it('keeps session ids on otherwise ignored step_start events', () => {
    const stepStart = {
      type: 'step_start',
      timestamp: 1781345478338,
      sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
      part: {
        id: 'prt_ec076e6c1001DVcresNhfJy8i2',
        sessionID: 'ses_13f89223effeq85h7RlKmjsV3M',
        messageID: 'msg_ec076de2d001eIfRD5tzzP0L6w',
        type: 'step-start',
      },
    };
    expect(parseOpencodeLine(JSON.stringify(stepStart))).toEqual({
      sessionId: 'ses_13f89223effeq85h7RlKmjsV3M',
    });
  });

  it('parses the real tool_use envelope with the nested state object', () => {
    const event = {
      type: 'tool_use',
      timestamp: 1786048283976,
      sessionID: 'ses_0273a1958ffelu0A0xTdGIQA1R',
      part: {
        type: 'tool',
        tool: 'read',
        callID: 'read_0',
        state: {
          status: 'completed',
          input: { filePath: '/repo/src/slug.ts' },
          output: '<path>/repo/src/slug.ts</path>\n<content>\n1: export function slugify',
          metadata: { preview: 'export function slugify', truncated: false },
          title: 'src/slug.ts',
          time: { start: 1786048283951, end: 1786048283974 },
        },
        id: 'prt_fd8c5fdad001DtBWs3PAZgfevh',
        sessionID: 'ses_0273a1958ffelu0A0xTdGIQA1R',
        messageID: 'msg_fd8c5e75b001X3Y1OQvzXwUSDI',
      },
    };
    expect(parseOpencodeLine(JSON.stringify(event))).toEqual({
      sessionId: 'ses_0273a1958ffelu0A0xTdGIQA1R',
      toolUseDone: [
        {
          id: 'read_0',
          name: 'read',
          input: { filePath: '/repo/src/slug.ts' },
          output: '<path>/repo/src/slug.ts</path>\n<content>\n1: export function slugify',
        },
      ],
    });
  });

  it('treats a nested state that is not completed as a tool start', () => {
    const event = {
      type: 'tool_use',
      sessionID: 'ses_running',
      part: {
        type: 'tool',
        tool: 'bash',
        callID: 'bash_0',
        state: { status: 'running', input: { command: 'npm test' } },
      },
    };
    expect(parseOpencodeLine(JSON.stringify(event))).toEqual({
      sessionId: 'ses_running',
      toolUseStart: [{ id: 'bash_0', name: 'bash', input: { command: 'npm test' } }],
    });
  });

  it('summarizes unknown records structurally without carrying the payload', () => {
    const secret = 'export const API_KEY = "sk-live-payload-1234";';
    const event = {
      type: 'mystery_record',
      sessionID: 'ses_unknown',
      part: {
        type: 'tool',
        state: { status: 'completed', output: secret },
      },
    };
    const result = parseOpencodeLine(JSON.stringify(event));
    const warning = result.warning?.[0];
    expect(warning?.code).toBe('unknown_opencode_record');
    expect(warning?.upstreamType).toBe('mystery_record');
    expect(warning?.message).toContain('mystery_record');
    expect(warning?.message).toContain('status');
    expect(warning?.message).not.toContain(secret);
    expect(warning?.message).not.toContain('sk-live-payload-1234');
  });

  it('does not carry the raw line in malformed JSON warnings', () => {
    const secret = 'BEGIN PRIVATE FILE CONTENT sk-live-payload-5678';
    const result = parseOpencodeLine(`{"broken": "${secret}`);
    const warning = result.warning?.[0];
    expect(warning?.code).toBe('malformed_opencode');
    expect(warning?.message).not.toContain(secret);
    expect(warning?.message).toContain('unparseable opencode line');
  });

  it('captures tool-use envelopes', () => {
    expect(
      parseOpencodeLine(
        JSON.stringify({
          type: 'tool_use',
          sessionID: 'ses_tool',
          part: {
            type: 'tool',
            id: 'tool-opencode',
            name: 'read_file',
            input: { path: 'src/a.ts' },
          },
        }),
      ),
    ).toEqual({
      sessionId: 'ses_tool',
      toolUseStart: [{ id: 'tool-opencode', name: 'read_file', input: { path: 'src/a.ts' } }],
    });
  });

  it('captures completed tool envelopes', () => {
    expect(
      parseOpencodeLine(
        JSON.stringify({
          type: 'tool_result',
          sessionID: 'ses_tool',
          part: {
            type: 'tool',
            id: 'tool-opencode',
            name: 'read_file',
            input: { path: 'src/a.ts' },
            output: 'contents',
          },
        }),
      ),
    ).toEqual({
      sessionId: 'ses_tool',
      toolUseDone: [
        {
          id: 'tool-opencode',
          name: 'read_file',
          input: { path: 'src/a.ts' },
          output: 'contents',
        },
      ],
    });
  });

  it('ignores the legacy top-level text/usage shapes that opencode never emits', () => {
    expect(parseOpencodeLine(JSON.stringify({ type: 'text', text: 'generated code' }))).toEqual({
      warning: [expect.objectContaining({ code: 'unknown_opencode_record' })],
    });
    expect(
      parseOpencodeLine(
        JSON.stringify({ type: 'step_finish', usage: { tokens: { input: 500, output: 200 } } }),
      ),
    ).toEqual({
      warning: [expect.objectContaining({ code: 'unknown_opencode_record' })],
    });
  });
});
