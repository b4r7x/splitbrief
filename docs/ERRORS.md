# Error Pattern

How errors are created, thrown, and narrowed in this codebase. One pattern, applied everywhere.

This doc is the authority. If you are writing a new error type or reading code that throws, this is where the contract is documented.

---

## The three rules

### Rule 1 — Zero classes for errors

No `class FooError extends Error`. Errors are built by a factory function that returns a plain `Error` object decorated with a discriminator field and a typed `data` payload.

This aligns with the codebase-wide zero-class rule (see [`CLAUDE.md`](../CLAUDE.md)). `Error` subclasses used to be a sanctioned exception — that exception is removed.

### Rule 2 — The discriminator is `kind: string`

Not `tag`, not `_tag`, not `type`, not `code`. The field is `kind`, and its values are **kebab-case strings**:

```ts
throw processError.notFound('git');
// → { kind: 'command-not-found', message: '...', data: { command: 'git' } }
```

One field, one convention, zero bike-shedding. Every domain error in the codebase uses `kind`.

### Rule 3 — Each domain exports a predicate bag

Factories and type guards for the same domain live together in a single `export const xError = { ... } as const` bag, placed next to the producer. The bag is the domain's error surface.

```ts
export const processError = {
  notFound: (command: string) => error('command-not-found', `Command not found: ${command}`, { command }),
  timeout: (command: string, output: string, ms: number) =>
    error('command-timeout', `${command} timed out after ${ms}ms`, { command, output, ms }),
  isNotFound: matches('command-not-found'),
  isTimeout: matches('command-timeout'),
} as const;
```

Call sites read fluently:

```ts
if (processError.isTimeout(err)) return showOutput(err.data.output);
throw processError.notFound(cmd);
```

---

## The primitive

**File:** `src/utils/error.ts`

```ts
export type AppError<K extends string = string, D = unknown> =
  Error & { readonly kind: K; readonly data: D };

export function error<K extends string, D = undefined>(
  kind: K,
  message: string,
  data?: D,
  cause?: unknown,
): AppError<K, D> {
  const err = new Error(message) as AppError<K, D>;
  Object.assign(err, { kind, data: data as D });
  if (cause !== undefined) (err as { cause: unknown }).cause = cause;
  return err;
}

export const matches = <K extends string>(kind: K) =>
  (err: unknown): err is AppError<K> =>
    err instanceof Error && (err as { kind?: unknown }).kind === kind;
```

Two exports: `error()` builds, `matches(kind)` returns a typed predicate. No subclasses, no prototypes, no mutation outside the factory.

---

## Domain bag pattern

A domain bag is a single `as const` object colocated with the module that produces the errors. It lives in the file that owns the domain — not in a central registry.

```ts
// src/lib/process/errors.ts
import { error, matches } from '../../utils/error.js';
import { redactSecrets } from '../../utils/redact.js';

type ProcessErrorData = { command: string; output?: string; code?: number };

export const processError = {
  notFound: (command: string) =>
    error('command-not-found', `Command not found: ${command}`, { command } satisfies ProcessErrorData),
  timeout: (command: string, output: string, ms: number) =>
    error('command-timeout', `${command} timed out after ${ms}ms`,
      { command, output: redactSecrets(output) }),
  outputFailure: (message: string, output: string) =>
    error('process-output', redactSecrets(message),
      { command: '', output: redactSecrets(output) }),
  isNotFound: matches('command-not-found'),
  isTimeout: matches('command-timeout'),
  isOutputFailure: matches('process-output'),
} as const;
```

**Bag contents:**
- Factory methods (lowercase camelCase) — return an `AppError`
- `isX` predicates — returned by `matches(kind)`, narrow `err` to the matching `AppError<kind>` type

Both live in the same `export const`. There is no separate `processErrorGuards.ts`.

### Predicates are YAGNI until a caller narrows

Do not add an `isXxx` predicate until a non-test caller needs to narrow on its kind. Factories and kinds are cheap; predicates without runtime callers are dead weight. Use `matches(err, 'kind')` from `utils/error.ts` for ad-hoc narrowing (e.g. inside tests or one-off branches) instead of pre-populating the bag. Unused predicates are YAGNI violations — delete them.

### Factories produce the final message

Error factories take structured arguments and return an `AppError` with a pre-formatted `message`. Callers do not format the message string separately and then hand it to the factory. One source of truth per kind: the factory.

```ts
// Do — factory formats the message
export const processError = {
  timeout: (opts: { command: string; label?: string; timeoutMs: number; output: string }) => {
    const subject = opts.label ?? opts.command;
    const seconds = Math.round(opts.timeoutMs / 1000);
    return error('command-timeout',
      `${subject} timed out after ${seconds}s`,
      { command: opts.command, label: opts.label, timeoutMs: opts.timeoutMs, output: opts.output });
  },
} as const;

// Caller — no formatting
throw processError.timeout({ command: 'codex', label: 'Codex', timeoutMs: 120_000, output });
```

```ts
// Don't — a separate formatter defeats the purpose of the bag
const msg = formatCommandError('timeout', { command: 'codex', label: 'Codex', timeoutMs: 120_000 });
throw processError.timeout(msg, output); // duplicated concerns, two places to keep in sync
```

If a caller needs a custom message that the factory's default would not produce (e.g. a CLI tool that wants `'Claude Code CLI not found. Install it from https://claude.ai/code'`), expose an optional `message` parameter on the factory. The factory still owns message construction — it just accepts the override rather than delegating to a second formatter.

---

## Call sites

### Throwing

```ts
throw processError.notFound('git');
throw processError.timeout('ollama serve', stderr, 30_000);
```

### Catching and narrowing

```ts
try {
  await spawn('ollama');
} catch (err) {
  if (processError.isNotFound(err)) {
    return promptInstall(err.data.command);
  }
  if (processError.isTimeout(err)) {
    return showStderr(err.data.output);
  }
  throw err;
}
```

Inside each branch, `err.data` is typed — `err.data.command` on the `isNotFound` branch, `err.data.output` on the `isTimeout` branch. TS narrows via the `kind` discriminator.

---

## Exhaustive matching with `switch`

When a function needs to handle every kind of a domain's errors exhaustively, use `switch(err.kind)` plus `assertNever` from `src/utils/type-guards.ts`:

```ts
import { assertNever } from '../utils/type-guards.js';

function formatProcessError(err: AppError<'command-not-found' | 'command-timeout' | 'process-output'>) {
  switch (err.kind) {
    case 'command-not-found': return `Install ${err.data.command} and retry.`;
    case 'command-timeout':   return `Timed out: ${err.data.output}`;
    case 'process-output':    return `Failed: ${err.data.output}`;
    default:                  return assertNever(err);
  }
}
```

`assertNever` forces compile-time exhaustiveness. Add a new factory to the bag without updating the `switch` → TS error.

Use this only when exhaustiveness is the goal. For one-or-two-case branches, `if (bag.isX(err))` is simpler.

### When to reach for `ts-pattern`

Only when matching on **nested fields** (e.g. `data.code === 404`). Today's code matches on `kind` alone — plain `switch` is enough and we do not take the dependency.

---

## `Error.cause` for wrapping

When an error wraps a lower-level one, thread the original through the fourth argument:

```ts
try {
  await readFile(path);
} catch (err) {
  throw configError.missing(path, err);  // factory passes err as cause to error()
}
```

`cause` is standard ECMAScript. The runtime preserves it, debuggers display it, and Node prints it in stack traces. Do not store the original error on a bespoke field — use `cause`.

---

## CliError — the top-level exit-code case

CLI subcommands need to map errors to process exit codes. `CliError` is a narrow specialization of the factory pattern — same shape, plus an `exitCode` field.

**File:** `src/cli/errors.ts`

```ts
export type CliError = Error & { readonly exitCode: number };

export function cliError(message: string, exitCode = 1): CliError {
  return Object.assign(new Error(message), { exitCode });
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof Error
    && 'exitCode' in err
    && typeof (err as { exitCode: unknown }).exitCode === 'number';
}
```

Usage:

```ts
if (!(await isGitRepo(projectDir))) {
  throw cliError('not a git repository. Run `git init` first.', 1);
}
```

The top-level catch in `src/cli.ts` checks `isCliError(err)` and calls `process.exit(err.exitCode)`. Every other error becomes exit code 1 with a formatted message.

`CliError` is allowed to differ from the domain-bag shape because its only predicate is `isCliError` — there is no matrix of "kinds" to discriminate. A domain that later needs both kinds and exit codes uses the `kind`+`data` pattern and lets the top-level handler read `err.data.exitCode`.

---

## Migration rule

1. **New code uses the factory + bag.** No new `Error` subclasses.
2. **When touching old `Error` subclass code**, migrate it in the same change. Do not leave a half-migrated file.

The four subclasses at the point of writing (`CommandNotFoundError`, `CommandTimeoutError`, `ProcessOutputError`, `IdleTimeoutError`) migrate to two bags: `processError` (three kinds, in `src/lib/process/errors.ts`) and `timeoutError` (one kind, in `src/utils/with-timeout.ts`). The three `instanceof` call sites in `engine/` become `processError.isNotFound(err)` / `timeoutError.isIdle(err)`.

---

## Why not the alternatives

**Why not `Error` subclasses (status quo):** forces a class exception to the zero-class rule with no benefit. `instanceof` is equivalent to `matches('kind')` at runtime, both narrow the type at compile time, and the factory gives us autocomplete on the bag (`processError.` → list of factories).

**Why not `neverthrow` / `Result<T, E>`:** viral type. Every function in the call chain has to declare `Result`. Forty-five `throw cliError(...)` sites today, almost none are branched on — a `Result`-typed call chain would be pure noise at those sites. See [ADR-0001](./adr/0001-error-pattern-domain-predicates.md).

**Why not `effect-ts`:** paradigm shift. Bundle size, learning curve, and dependency footprint are too large for a single-binary CLI that throws in fewer than 50 places.

**Why not `ts-pattern`:** pulls in a library for a one-case need. Plain `switch(err.kind)` handles our current matching. Revisit only when we need to match on `data.*` fields.

**Why not a central `AppError` registry:** breaks colocation. Every new error would edit a central file, separating the factory from its domain.

**Why not symbol-branded errors:** less idiomatic, harder to inspect at a debugger (symbol keys don't show up in `JSON.stringify`), no autocomplete.

---

## Anti-patterns

| Don't | Why |
|---|---|
| `class FooError extends Error` | Zero-class rule; no sanctioned exception for errors |
| `throw new Error('foo')` without a bag for a new domain | Bare errors lose the discriminator — call sites can't branch |
| Separate `foo-errors.ts` and `foo-guards.ts` | Bag puts factories and predicates together; splitting is indirection |
| `isKind(err, 'something')` with a stringly-typed helper | Replaced by `bag.isSomething(err)` — same cost, better autocomplete |
| `type: 'x'` or `tag: 'x'` discriminator | The field is `kind` everywhere |
| `throw new Error(...); (err as any).code = 'x'` | Use `error('x', msg, data)` — the factory exists to stop this |
| Storing the inner error on a custom field (e.g. `err.inner`) | Use `cause` — standard, debugger-friendly |
| Catching and rethrowing without wrapping the cause | If you lose context on rethrow, you lose the debug trail |

---

## References

- [ADR-0001](./adr/0001-error-pattern-domain-predicates.md) — decision record and alternatives
- [CLAUDE.md](../CLAUDE.md) — zero-class rule
- [LAYERS.md](./LAYERS.md) — which layer owns which error bag
- [TYPES.md](./TYPES.md) — type placement (factory bags colocate with their producer, per three-case rule)
- [TC39 — Error Cause](https://github.com/tc39/proposal-error-cause) — `cause` field spec
