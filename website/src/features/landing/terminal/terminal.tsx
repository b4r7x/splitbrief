import { useState } from 'react';
import type { FormEvent } from 'react';
import { useReducedMotion } from '../matrix/matrix-media.js';
import { PATCH_FIELD_ID } from '../sections/patch-field.js';
import { Wordmark } from '../wordmark.js';
import { pairingStatus, usePairingCycle } from './use-pairing-cycle.js';
import './terminal.css';

// Structure and copy follow the real entrance frame captured at 120x40:
// .test-artifacts/ui/final-smoke/…/home-empty/120x40/ready/frame.txt
const HINT_ROW = '/help · /settings · /skills · ctrl+k commands';
const WORKFLOW_MODE = 'standard';

function PairingLine({ paused }: { readonly paused: boolean }) {
  const status = pairingStatus(usePairingCycle(paused));

  return (
    <p className="terminal__pairing">
      <span className="terminal__segment">
        <span className="terminal__role terminal__role--planner">{status.plannerLabel}</span>
        {status.plannerModel ? (
          <>
            <span className="terminal__punct"> &gt; </span>
            <span className="terminal__model">{status.plannerModel}</span>
          </>
        ) : null}
      </span>{' '}
      <span className="terminal__segment">
        <span className="terminal__punct">· </span>
        <span className="terminal__role terminal__role--implementer">
          {status.implementerLabel}
        </span>
        <span className="terminal__punct"> &gt; </span>
        <span className="terminal__model">{status.implementerModel}</span>
      </span>{' '}
      <span className="terminal__segment">
        <span className="terminal__punct">· </span>
        <span className="terminal__mode">{WORKFLOW_MODE}</span>
      </span>
    </p>
  );
}

function Composer({ reducedMotion }: { readonly reducedMotion: boolean }) {
  const [empty, setEmpty] = useState(true);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    document.getElementById(PATCH_FIELD_ID)?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  }

  return (
    <form className="terminal__composer" onSubmit={handleSubmit}>
      <span aria-hidden="true" className="terminal__composer-prompt">
        &gt;
      </span>
      <span className="terminal__composer-field">
        <input
          aria-label="Command entry — press Enter to jump to the patch field"
          autoComplete="off"
          className="terminal__composer-input"
          data-empty={empty ? '' : undefined}
          enterKeyHint="go"
          onInput={(event) => setEmpty(event.currentTarget.value.length === 0)}
          spellCheck={false}
          type="text"
        />
        {empty ? <span aria-hidden="true" className="terminal__caret" /> : null}
      </span>
      <span aria-hidden="true" className="terminal__composer-hint">
        ↵ patch a pairing
      </span>
    </form>
  );
}

export function TerminalEntrance() {
  const reducedMotion = useReducedMotion();

  return (
    <div className="terminal">
      <div className="terminal__faceplate">
        <span className="terminal__shell">~ % splitbrief</span>
        <span className="terminal__provenance">html recreation</span>
      </div>

      <div className="terminal__screen">
        <div className="terminal__wordmark">
          <Wordmark className="terminal__wordmark-tier terminal__wordmark-tier--full" tier="full" />
          <Wordmark className="terminal__wordmark-tier terminal__wordmark-tier--compact" />
        </div>

        <PairingLine paused={reducedMotion} />

        <div className="terminal__sessions">
          <p className="terminal__sessions-label">Recent sessions</p>
          <p className="terminal__sessions-empty">No recent sessions</p>
        </div>

        <div className="terminal__ground" />

        <p className="terminal__hints">{HINT_ROW}</p>

        <Composer reducedMotion={reducedMotion} />
      </div>
    </div>
  );
}
