import { useState, useRef } from 'react';
import type { Screen, RouteData, Summary, WorkflowState } from '../types.js';

const transitions: Record<Screen, Screen[]> = {
  home: ['workflow'],
  workflow: ['summary'],
  summary: ['home', 'workflow'],
};

export function useRouter(initialRoute?: RouteData) {
  const [routeData, setRouteData] = useState<RouteData>(initialRoute ?? { screen: 'home' });
  const screenRef = useRef(routeData.screen);
  screenRef.current = routeData.screen;

  const screen = routeData.screen;

  const navigate = (to: Screen, data?: { feature?: string; summary?: Summary; resumeState?: WorkflowState }) => {
    if (!transitions[screenRef.current].includes(to)) {
      throw new Error(`Cannot navigate from "${screenRef.current}" to "${to}"`);
    }

    let next: RouteData;
    switch (to) {
      case 'home':
        next = { screen: 'home' };
        break;
      case 'workflow':
        next = { screen: 'workflow', feature: data?.feature ?? '', resumeState: data?.resumeState };
        break;
      case 'summary':
        if (!data?.summary) throw new Error('Summary data required');
        next = { screen: 'summary', summary: data.summary };
        break;
    }

    setRouteData(next);
  };

  return { screen, routeData, navigate };
}
