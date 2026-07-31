import { PanelStrip } from '../../../components/panel-strip.js';
import './console.css';

const FRAME_ALT =
  'SPLITBRIEF mid-implementation, 4 minutes 5 seconds in: tasks 1 and 2 of 3 are complete, and task 3 “Detect available Ollama models” is running on Qwen 2.5 Coder 7B via Ollama, which has edited src/engine/detection/service.ts and src/engine/detection/service.test.ts and is running the detection service tests.';

export function ConsoleSection() {
  return (
    <PanelStrip className="console-section" id="console" legend="The console">
      <figure className="console-section__figure">
        <div className="console-section__artifact">
          <picture>
            <source
              height={288}
              media="(max-width: 699px)"
              srcSet="/frames/workflow-implementation-60x18.svg"
              width={480}
            />
            <img
              alt={FRAME_ALT}
              className="console-section__frame"
              height={608}
              src="/frames/workflow-implementation-120x38.svg"
              width={960}
            />
          </picture>
        </div>
        <figcaption className="console-section__caption">
          <span aria-hidden="true" className="console-section__provenance">
            <span className="console-section__geometry console-section__geometry--wide">
              workflow-implementation / real capture · header cropped /{' '}
              <span className="console-section__dims">120 × 38</span>
            </span>
            <span className="console-section__geometry console-section__geometry--narrow">
              workflow-implementation / real capture /{' '}
              <span className="console-section__dims">60 × 18</span>
            </span>
          </span>
          <span className="console-section__whisper">You pay for the thinking once.</span>
        </figcaption>
      </figure>
    </PanelStrip>
  );
}
