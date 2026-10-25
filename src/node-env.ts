import { runAsProduction } from './lib/process/spawn/child-env.js';

// React's development build records a performance.measure() per render into
// Node's unbounded user-timing buffer; a streaming planner call re-renders the
// TUI on every delta, so a run grew past the 4 GB heap limit in minutes.
runAsProduction();
