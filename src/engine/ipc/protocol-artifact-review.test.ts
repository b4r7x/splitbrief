import { describe, expect, it } from 'vitest';
import { PLANNER_ARTIFACT_MAX_BYTES } from '../runners/types.js';
import { parseIpcPromptResponse, parseServerMessage } from './protocol.js';

describe('strict artifact review protocol', () => {
  it('parses immutable artifact review prompts without a file path', () => {
    const msg = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-artifact',
        kind: 'artifact_review',
        review: {
          label: 'Custom planner artifact',
          text: '# candidate\n\u0000preserve this exactly\n',
        },
      },
    };

    expect(parseServerMessage(msg)).toEqual(msg);
  });

  it('accepts an artifact review at the declared byte limit without normalization', () => {
    const text = '\u0000'.repeat(PLANNER_ARTIFACT_MAX_BYTES);
    const msg = {
      kind: 'prompt_request',
      request: {
        requestId: 'req-artifact-limit',
        kind: 'artifact_review',
        review: { label: 'Custom planner artifact', text },
      },
    };

    const parsed = parseServerMessage(msg);
    expect(parsed).toEqual(msg);
    if (parsed?.kind === 'prompt_request' && parsed.request.kind === 'artifact_review') {
      expect(parsed.request.review.text).toBe(text);
    }
  });

  it('rejects artifact review text one byte over the declared limit', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-artifact-too-large',
          kind: 'artifact_review',
          review: {
            label: 'Custom planner artifact',
            text: '\u0000'.repeat(PLANNER_ARTIFACT_MAX_BYTES + 1),
          },
        },
      }),
    ).toBeNull();
  });

  it('rejects file paths in the strict artifact review envelope', () => {
    const review = { label: 'Custom planner artifact', text: '# candidate\n' };
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-artifact-path',
          kind: 'artifact_review',
          review,
          filePath: '.custom-runner-review/call-1/result',
        },
      }),
    ).toBeNull();
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-artifact-nested-path',
          kind: 'artifact_review',
          review: { ...review, filePath: '.custom-runner-review/call-1/result' },
        },
      }),
    ).toBeNull();
  });

  it('rejects the legacy path-based artifact approval prompt', () => {
    expect(
      parseServerMessage({
        kind: 'prompt_request',
        request: {
          requestId: 'req-artifact',
          kind: 'approval_needed',
          approvalType: 'artifact',
          filePath: '.custom-runner-review/call-1/result',
          allowedCommands: [],
        },
      }),
    ).toBeNull();
  });

  it('accepts only boolean artifact-review responses with no path fields', () => {
    expect(parseIpcPromptResponse({ kind: 'artifact_review', approved: true })).toEqual({
      kind: 'artifact_review',
      approved: true,
    });
    expect(
      parseIpcPromptResponse({
        kind: 'artifact_review',
        approved: true,
        filePath: '.custom-runner-review/call-1/result',
      }),
    ).toBeNull();
  });
});
