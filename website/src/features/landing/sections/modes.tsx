import { PanelStrip } from '../../../components/panel-strip.js';
import './modes.css';

// Verified against docs/WORKFLOW.md §3 "Mode dispatch" (Planner calls, Default
// approval, and Artifacts columns) and §3 "Approval gates" (briefs review note).
const MODES = [
  { name: 'instant', plannerCalls: '1', approval: 'none', artifacts: 'tasks.md' },
  { name: 'quick', plannerCalls: '1', approval: 'none', artifacts: 'tasks.md' },
  {
    name: 'standard',
    plannerCalls: '4',
    approval: 'spec',
    artifacts: 'research, spec.md, plan.md, tasks.md',
  },
  {
    name: 'speckit',
    plannerCalls: '6–7',
    approval: 'all',
    artifacts:
      'research, spec.md, clarifications.md, constitution-check.json, plan.md, tasks.md, analyze.json',
  },
] as const;

export function ModesSection() {
  return (
    <PanelStrip className="modes-panel panel-strip--band" id="modes" legend="Modes">
      <div className="modes-rack">
        <table className="modes-table">
          <thead>
            <tr>
              <th scope="col">Mode</th>
              <th scope="col">Planner calls</th>
              <th scope="col">Default approval</th>
              <th scope="col">Artifacts</th>
            </tr>
          </thead>
          <tbody>
            {MODES.map((mode) => (
              <tr key={mode.name}>
                <th scope="row">{mode.name}</th>
                <td className="tnum modes-table__calls">{mode.plannerCalls}</td>
                <td className="modes-table__approval">{mode.approval}</td>
                <td className="modes-table__artifacts">{mode.artifacts}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modes-note">
          <p>
            Counts are the workflow reference's own, for a clean run. A successful run adds one
            final-review call; regeneration, clarifications, retries, and escalation add more.{' '}
            <a className="inline-link" href="/docs/concepts/workflow-modes-and-phases">
              Modes and phases, in full.
            </a>
          </p>
          <p>
            <code>standard</code> and <code>speckit</code> also pause for briefs review before
            implementing.
          </p>
        </div>
      </div>
    </PanelStrip>
  );
}
