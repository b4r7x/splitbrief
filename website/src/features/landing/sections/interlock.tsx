import { PanelStrip } from '../../../components/panel-strip.js';
import './interlock.css';

const INTERLOCK_LINES = [
  {
    channel: 'gate',
    text: 'Review gates pause on spec, plan, and briefs when active; declared file writes route through auto, sticky, or confirm tiers.',
  },
  {
    channel: 'check',
    text: 'Enabled checks run in order: typecheck → lint → test.',
  },
  {
    channel: 'fault',
    text: 'Failures retry locally, then climb configured escalation tiers; exhausted paths surface recovery.',
  },
  {
    channel: 'state',
    text: 'Snapshot restores are hash-guarded against user edits; saved sessions resume from disk.',
  },
] as const;

export function InterlockSection() {
  return (
    <PanelStrip className="interlock-section" id="interlock" legend="The interlock">
      <div className="interlock-section__rack">
        <div className="interlock-section__phase-bank">
          <p className="interlock-section__calibration">Control bus / 05 phases</p>
          <ol aria-label="Workflow phase rail" className="interlock-section__phase-rail">
            <li className="interlock-section__phase interlock-section__phase--planner">
              <span>Spec</span>
              <span className="interlock-section__connector"> › </span>
            </li>
            <li className="interlock-section__phase interlock-section__phase--planner">
              <span>Plan</span>
              <span className="interlock-section__connector"> › </span>
            </li>
            <li className="interlock-section__phase interlock-section__phase--planner">
              <span>Briefs</span>
              <span className="interlock-section__connector interlock-section__connector--handoff interlock-section__connector--crossing">
                {' → '}
                <span aria-hidden="true" className="interlock-section__crossing-pin" />
              </span>
            </li>
            <li className="interlock-section__phase interlock-section__phase--implementer">
              <span>Build</span>
              <span className="interlock-section__connector interlock-section__connector--handoff">
                {' → '}
              </span>
            </li>
            <li className="interlock-section__phase interlock-section__phase--validator">Verify</li>
          </ol>
        </div>

        <ul aria-label="Orchestration controls" className="interlock-section__controls">
          {INTERLOCK_LINES.map(({ channel, text }) => (
            <li key={channel}>
              <span className={`interlock-section__channel interlock-section__channel--${channel}`}>
                {channel}
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </div>
    </PanelStrip>
  );
}
