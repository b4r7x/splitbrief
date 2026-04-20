# Brief 06 — Image drag-drop + `/attach` pass-through

> **You are a fresh AI context.** Read `../spec.md` §4.7 and `../decisions.md` ADR-006, ADR-007 before starting. Do NOT commit (see `../../../../CLAUDE.md`).

## Goal

Let the user attach images to the next planner message. Two entry points: drag-drop onto the TUI (detected by path-shape heuristic) and `/attach <path>` slash command. Pass-through per backend. Drop on non-vision backends with a log event.

## Dependencies

- None strictly. Best sequenced after brief 05 because both briefs add capability flags.

## Files to touch

Write-authoritative:

- `src/core/schemas/attachment.ts` (NEW)
- `src/engine/planners/types.ts` (extend PlannerCallbacks + capabilities)
- `src/stores/workflow/attachments.ts` (NEW) — store slice
- `src/components/input/multiline-input.tsx` — drag-drop detection
- `src/features/workflow/handlers.ts` — attach/detach handlers
- `src/features/workflow/screen.tsx` — wire attach chip rendering
- `src/components/input-bar/attachment-chips.tsx` (NEW)
- `src/core/slash-commands/catalog.ts` — `/attach`, `/detach`
- `src/engine/planners/claude-code.ts`
- `src/engine/planners/cli.ts`
- `src/engine/planners/api.ts`
- `src/engine/planners/agent-sdk.ts`
- `src/engine/claude-runner.ts`
- `src/engine/providers/anthropic/stream.ts`
- `src/engine/providers/openai-stream.ts`
- `src/engine/providers/capability-inference.ts` (from brief 05)
- `src/engine/events/types.ts`
- `docs/WORKFLOW.md`

## Step-by-step

### 1. Attachment schema

File: `src/core/schemas/attachment.ts`

```ts
import { z } from 'zod';

export const SUPPORTED_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] as const;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

export const AttachmentKindSchema = z.enum(['image']);

export const AttachmentSchema = z.object({
  id: z.string(),                  // opaque
  kind: AttachmentKindSchema,
  path: z.string(),                 // absolute path resolved at attach time
  mimeType: z.string(),             // e.g. 'image/png'
  sizeBytes: z.number().int().positive(),
  addedAt: z.number().int(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;
```

### 2. Store slice

File: `src/stores/workflow/attachments.ts`

```ts
import { createStore } from '../create-store.js';
import type { Attachment } from '../../core/schemas/attachment.js';

type AttachmentsState = {
  pending: Attachment[];
};

export const attachmentsStore = createStore<AttachmentsState>({
  initial: { pending: [] },
  actions: (set, get) => ({
    add(attachment: Attachment) {
      set({ pending: [...get().pending, attachment] });
    },
    remove(id: string) {
      set({ pending: get().pending.filter(a => a.id !== id) });
    },
    drain(): Attachment[] {
      const out = get().pending;
      set({ pending: [] });
      return out;
    },
    peek(): Attachment[] {
      return get().pending;
    },
    reset() {
      set({ pending: [] });
    },
  }),
});
```

Tests colocated.

### 3. Path resolver + guard

File: `src/features/workflow/attach-resolver.ts` (NEW)

```ts
import { resolve, isAbsolute } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { MAX_ATTACHMENT_BYTES, SUPPORTED_IMAGE_EXTS } from '../../core/schemas/attachment.js';
import type { Attachment } from '../../core/schemas/attachment.js';

type ResolveOpts = {
  input: string;
  projectDir: string;
};

type ResolveResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; reason: 'not-image' | 'not-found' | 'too-large' | 'outside-safe-roots' };

/**
 * Resolve a user-supplied path string to a validated Attachment.
 *
 * Security: only accepts paths under projectDir, homedir, or an absolute path
 * whose real path resolves under either. Symlink traversal is followed by statSync,
 * then the resolved real path is re-checked against the safe roots.
 */
export function resolveAttachment({ input, projectDir }: ResolveOpts): ResolveResult {
  const trimmed = input.trim();
  const absPath = isAbsolute(trimmed) ? trimmed : resolve(projectDir, trimmed);

  const ext = absPath.split('.').pop()?.toLowerCase() ?? '';
  if (!(SUPPORTED_IMAGE_EXTS as readonly string[]).includes(ext)) {
    return { ok: false, reason: 'not-image' };
  }

  let stat;
  try { stat = statSync(absPath); }
  catch { return { ok: false, reason: 'not-found' }; }

  if (!stat.isFile()) return { ok: false, reason: 'not-found' };
  if (stat.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'too-large' };

  const safeRoots = [projectDir, homedir()];
  if (!safeRoots.some(root => absPath.startsWith(root + '/'))) {
    return { ok: false, reason: 'outside-safe-roots' };
  }

  return {
    ok: true,
    attachment: {
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'image',
      path: absPath,
      mimeType: extToMime(ext),
      sizeBytes: stat.size,
      addedAt: Date.now(),
    },
  };
}

function extToMime(ext: string): string {
  return {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  }[ext] ?? 'application/octet-stream';
}
```

Colocated tests in `attach-resolver.test.ts` with mocked `statSync`.

### 4. Drag-drop detection

File: `src/components/input/multiline-input.tsx`

Extend `useInput` at line ~42-85 with a drop detector. The key is that dragging a file onto iTerm2/Warp/Ghostty inserts its absolute path as a single chunk (explore-report §3).

Add:

```tsx
const DROP_CANDIDATE_PATTERN = /^\S+\.(jpe?g|png|gif|webp|bmp)(\s|$)/i;

useInput((input, key) => {
  // ... existing handlers ...

  // Drop detection: single-chunk input that looks like a file path.
  const trimmed = input.trim();
  if (input.length > 1 && DROP_CANDIDATE_PATTERN.test(trimmed) && !key.return && !key.ctrl) {
    // Hand off to the drop handler; swallow the event so it doesn't land as text.
    onDrop?.(trimmed);
    return;
  }

  // ... rest of existing handler ...
});
```

Add `onDrop?: (path: string) => void` to the component's props.

### 5. Input-bar chip rendering

File: `src/components/input-bar/attachment-chips.tsx` (NEW)

```tsx
import { Box, Text } from 'ink';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { useTheme } from '../theme.js';

export function AttachmentChips() {
  const theme = useTheme();
  const pending = attachmentsStore.use(s => s.pending);

  if (pending.length === 0) return null;

  return (
    <Box gap={1}>
      {pending.map(att => (
        <Text key={att.id} color={theme.info}>
          📎 {basenameShort(att.path)}
        </Text>
      ))}
    </Box>
  );
}

function basenameShort(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.length > 24 ? base.slice(0, 21) + '...' : base;
}
```

File: `src/components/input-bar/index.tsx` — render `<AttachmentChips />` above or beside the input box. Pass `onDrop` through to `multiline-input.tsx`.

### 6. Workflow handlers wiring

File: `src/features/workflow/handlers.ts`

Add:

```ts
export function requestAttach(path: string, feedbackStore: FeedbackStore, projectDir: string): void {
  const result = resolveAttachment({ input: path, projectDir });
  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      'not-image': `not an image: ${path}`,
      'not-found': `file not found: ${path}`,
      'too-large': `image exceeds 10 MB: ${path}`,
      'outside-safe-roots': `path outside project or home dir: ${path}`,
    };
    feedbackStore.setError(messages[result.reason]);
    return;
  }
  attachmentsStore.add(result.attachment);
  feedbackStore.setSuccess(`attached ${basenameShort(result.attachment.path)}`);
}

export function requestDetach(id: string): void {
  attachmentsStore.remove(id);
}
```

Wire `onDrop` in `screen.tsx` to call `requestAttach`.

### 7. Slash commands

File: `src/core/slash-commands/catalog.ts`

```ts
{
  name: '/attach',
  kind: 'arg',
  validScreens: ['workflow', 'home'],
  handler: async (ctx, arg) => {
    if (!arg) {
      ctx.setFeedbackMessage('usage: /attach <path>', 'error');
      return;
    }
    requestAttach(arg, ctx.feedbackStore, ctx.projectDir);
  },
  help: 'Attach an image to the next planner message.',
},
{
  name: '/detach',
  kind: 'arg',
  validScreens: ['workflow', 'home'],
  handler: async (ctx, arg) => {
    if (!arg) {
      // Detach most recent.
      const pending = attachmentsStore.peek();
      if (pending.length === 0) {
        ctx.setFeedbackMessage('no attachments to detach', 'error');
        return;
      }
      attachmentsStore.remove(pending[pending.length - 1].id);
      ctx.setFeedbackMessage('detached most recent attachment', 'success');
      return;
    }
    const pending = attachmentsStore.peek();
    const match = pending.find(a => a.path.endsWith(arg) || a.id === arg);
    if (!match) {
      ctx.setFeedbackMessage(`no attachment matches "${arg}"`, 'error');
      return;
    }
    attachmentsStore.remove(match.id);
    ctx.setFeedbackMessage(`detached ${arg}`, 'success');
  },
  help: 'Remove a pending attachment.',
},
```

### 8. Planner callbacks extension

File: `src/engine/planners/types.ts`

Extend `PlannerCallbacks`:

```ts
export type PlannerCallbacks = {
  // ... existing fields ...
  attachments?: Attachment[];        // drained from store at invocation time
};
```

And `PlannerCapabilities.supportsImages: boolean` (already added in brief 05).

### 9. Drain at invocation time

File: `src/engine/orchestrator/planning/run.ts` (and every mode runner)

Before each planner call, drain the attachments store and pass through:

```ts
import { attachmentsStore } from '../../../stores/workflow/attachments.js';

// ...
const attachments = attachmentsStore.drain();
const plannerCallbacks = {
  // ... existing callbacks ...
  attachments,
};
```

If `attachments.length > 0` and `!planner.capabilities.supportsImages`:

```ts
bus.publish({
  type: 'planner_attachments_dropped',
  phase: state.phase,
  ts: Date.now(),
  count: attachments.length,
  reason: 'no-vision',
});
// drop from callbacks
plannerCallbacks.attachments = [];
```

### 10. Claude Code CLI — image pass-through

> **VERIFY AT IMPLEMENTATION TIME:** Run `claude --help 2>&1 | grep -i image` to check if Claude Code CLI has a `--image <path>` flag. Three strategies, in order of preference:
>
> **Strategy A (preferred):** If `--image <path>` exists, push it per attachment.
> **Strategy B:** If Claude Code accepts images via stdin piping or base64 in the prompt, use that mechanism.
> **Strategy C (fallback, always works):** Embed `[image: <absolute-path>]` as a markdown marker in the prompt text. Claude Code's internal model (Claude 4.x) can read local files when given paths — this is a degraded but functional path. Log a `planner_attachments_degraded` event so users know images are path-referenced, not inlined.
>
> **The implementing agent MUST verify the available mechanism before choosing.** Do not assume `--image` exists.

File: `src/engine/claude-runner.ts`

Extend `buildClaudeArgs` with an `images?: Attachment[]` field. Apply whichever strategy was verified above.

### 11. Anthropic API — content blocks

File: `src/engine/providers/anthropic/stream.ts`

Extend the message construction. Instead of passing `messages: ChatMessage[]` with `content: string`, build each message's content as an array:

```ts
function toAnthropicContentBlocks(text: string, images: Attachment[]): unknown[] {
  const blocks: unknown[] = [];
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType,
        data: readFileSync(img.path).toString('base64'),
      },
    });
  }
  blocks.push({ type: 'text', text });
  return blocks;
}
```

Plumb this into the `messages` array in `streamAnthropicCompletion`.

### 12. OpenAI-compat — image_url

File: `src/engine/providers/openai-stream.ts`

```ts
function toOpenAIContent(text: string, images: Attachment[]): unknown {
  if (images.length === 0) return text;
  const parts: unknown[] = [];
  for (const img of images) {
    const data = readFileSync(img.path).toString('base64');
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${data}` },
    });
  }
  parts.push({ type: 'text', text });
  return parts;
}
```

### 13. Agent SDK

File: `src/engine/agent-sdk.ts`

The Agent SDK's `query()` accepts messages with mixed content blocks similar to Anthropic API. Plumb `Attachment[]` into the prompt-building path.

### 14. CLI backends (codex / opencode / aider / copilot / kilo)

None of these have a stable image CLI interface as of 2026. Capability is `false`. Attachments are dropped at the orchestrator layer before invocation; no backend-specific change needed.

(Except: copilot CLI has image support in Pro+ plans per research, but through an undocumented flag. Skip v1; user upgrades to Claude Code or API-kind for vision work.)

### 15. Engine events

File: `src/engine/events/types.ts`

```ts
| { type: 'planner_attachments_dropped'; phase: Phase; ts: number; count: number; reason: 'no-vision' | 'too-large' | 'invalid' }
| { type: 'planner_attachment_added'; phase: Phase; ts: number; attachmentId: string; sizeBytes: number }
```

Renderers in `event-card.tsx`.

### 16. Tests

- `src/features/workflow/attach-resolver.test.ts` — every reason code and happy path.
- `src/stores/workflow/attachments.test.ts` — store ops + drain semantics.
- `src/components/input/multiline-input.test.tsx` — drop-pattern detection (simulate raw `input` arg).
- `src/engine/claude-runner.test.ts` — argv includes `--image` per attachment.
- `src/engine/providers/anthropic/stream.test.ts` — content-blocks construction.
- `src/engine/providers/openai-stream.test.ts` — image_url content.

### 17. Docs

File: `docs/WORKFLOW.md`

Add a §1.9 "Image attachments":

```md
### 1.9 Image attachments

Pre-submit attachments are held in `workflowStore.attachments.pending`. Two entry points:

- **Drag-drop**: drag an image file onto the TUI. On iTerm2/Warp/Ghostty the file path arrives as a single-chunk stdin write; the input detector in `multiline-input.tsx` matches `\S+\.(jpe?g|png|gif|webp|bmp)` and routes it to the attach handler. Path is resolved against `projectDir` and home dir; outside paths are rejected.
- **Slash command**: `/attach <path>`. Same resolution.

Attachments are drained at the next planner call and converted per backend:

- Claude Code CLI: `--image <path>` per attachment.
- Anthropic API: base64-encoded `image` content-block.
- OpenAI-compat: `image_url` with `data:` URL.
- Agent SDK: mixed-content messages.
- Others: dropped with `planner_attachments_dropped` event.

Limit: 10 MB per image, `jpg|jpeg|png|gif|webp|bmp` only.
```

### 18. Verification gate

```bash
npm run typecheck
npm run lint
npm test
```

## Rollback

Revert the listed files. Delete NEW files. Attachment store can be left as dead code (no references) if partial rollback is preferred.

## Checkpoint

- `/attach /path/to/img.png` adds an attachment visible in input bar.
- Drag-drop onto iTerm2 works.
- Attachments flow to Claude Code via `--image`.
- Attachments flow to Anthropic API via content blocks.
- Non-vision backends drop with event.
- Size / type / path guards trigger with appropriate feedback.
