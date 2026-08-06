// The context window assumed for any runner that declares no contextLength and
// whose provider exposes no detected window. Both the prompt builder (currentCode
// truncation) and the request builder (max_tokens) resolve to this same value, so
// an omitted contextLength never means "unlimited" to one consumer and 32768 to
// the other. 32768 clears the `standard` mode readiness floor
// (core/readiness/checks/context.ts); a smaller assumption would make the default
// workflow mode fail the project's own minimum before a brief is written.
export const DEFAULT_UNKNOWN_CONTEXT_LENGTH = 32_768;
