import { PanelStrip } from '../../../components/panel-strip.js';
import './runner-kinds.css';

const RUNNER_KINDS = [
  {
    kind: 'cli',
    description: 'Known tool subprocess',
    examples: ['claude-code', 'codex', 'opencode', 'aider', 'copilot', 'kilo-code'],
  },
  {
    kind: 'api',
    description: 'Configured HTTP endpoint',
    examples: ['Ollama', 'LM Studio', 'OpenRouter', 'DeepSeek', 'Groq', 'Together', 'Anthropic'],
  },
  {
    kind: 'shell',
    description: 'Custom stdin/stdout command',
    examples: [],
  },
  {
    kind: 'agent',
    description: 'File-writing subprocess',
    examples: [],
  },
  {
    kind: 'agent-sdk',
    description: 'Anthropic Agent SDK',
    examples: [],
  },
] as const;

export function RunnerKindsSection() {
  return (
    <PanelStrip className="runner-kinds panel-strip--band" id="kinds" legend="Runner kinds">
      <p className="runner-kinds__lead">Five supported runner kinds on either side.</p>

      <section
        aria-label="Runner-kind crossing table"
        className="runner-kinds__table-scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: axe and Safari require a keyboard-focusable scroll region.
        tabIndex={0}
      >
        <table className="runner-kinds__table">
          <caption>Planner and implementer runner-kind crossings</caption>
          <thead>
            <tr>
              <th scope="col">Planner / implementer</th>
              {RUNNER_KINDS.map((runner) => (
                <th className="runner-kinds__implementer" key={runner.kind} scope="col">
                  <code>{runner.kind}</code>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {RUNNER_KINDS.map((planner) => (
              <tr key={planner.kind}>
                <th className="runner-kinds__planner" scope="row">
                  <code>{planner.kind}</code>
                </th>
                {RUNNER_KINDS.map((implementer) => (
                  <td key={implementer.kind}>
                    <span aria-hidden="true" className="runner-kinds__crossing" />
                    <span className="runner-kinds__visually-hidden">
                      {planner.kind} planner to {implementer.kind} implementer
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <dl className="runner-kinds__ledger">
        {RUNNER_KINDS.map((runner) => (
          <div key={runner.kind}>
            <dt>
              <code>{runner.kind}</code>
            </dt>
            <dd>
              <span>{runner.description}</span>
              {runner.examples.length > 0 ? (
                <ul aria-label={`${runner.kind} examples`}>
                  {runner.examples.map((example) => (
                    <li key={example}>{example}</li>
                  ))}
                </ul>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      <p className="runner-kinds__contract">
        Every kind-to-kind intersection can be expressed when its required fields and runner
        contract are supplied. Built-in tool IDs cover named CLIs and providers; custom runners use
        explicit <code>shell</code>, <code>agent</code>, or <code>agent-sdk</code> contracts.{' '}
        <a className="inline-link" href="/docs/guides/planners-and-implementers">
          Read the planners and implementers guide.
        </a>
      </p>
    </PanelStrip>
  );
}
