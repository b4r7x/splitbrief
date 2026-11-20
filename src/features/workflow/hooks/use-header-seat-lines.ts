import { configStore } from '../../../stores/project/config.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import {
  useCrewDisplayNames,
  readCrewDisplayNames,
} from '../../../hooks/use-crew-display-names.js';
import { useRunningSeats, readRunningSeats } from './use-running-seats.js';
import { useHaltRanOn, readHaltRanOn } from './use-halt-ran-on.js';
import { displayedCrewRecord } from '../at-rest.js';
import {
  displayedSeatLines,
  headerSeats,
  type HeaderSeatLines,
  type HeaderSeats,
} from '../display/header-seat-lines.js';

/** The crew lines on display, for the screen and the header to choose their rail beside. */
export function useHeaderSeatLines(): HeaderSeatLines {
  const config = configStore.use((s) => s.config);
  const running = useRunningSeats();
  const displayNames = useCrewDisplayNames(config);
  const halt = runViewStore.use((s) => s.halt);
  const phase = runViewStore.use((s) => s.phase);
  const ranOn = useHaltRanOn();
  const route = routerStore.use((s) => s);
  return displayedSeatLines(
    displayedCrewRecord(route, phase),
    headerSeats({ config, running, displayNames, halt, ranOn }),
  );
}

/** Today's seats read from the stores, for `readHeaderSeatLines`. */
function readHeaderSeats(): HeaderSeats | null {
  const config = configStore.get().config;
  return headerSeats({
    config,
    running: readRunningSeats(),
    displayNames: readCrewDisplayNames(config),
    halt: runViewStore.get().halt,
    ranOn: readHaltRanOn(),
  });
}

/** The same crew lines over the stores, for the click-zone snapshot that reads outside React. */
export function readHeaderSeatLines(): HeaderSeatLines {
  return displayedSeatLines(
    displayedCrewRecord(routerStore.get(), runViewStore.get().phase),
    readHeaderSeats(),
  );
}
