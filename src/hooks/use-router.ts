import { useState } from 'react';
import type { Screen, RouteData, Summary, WorkflowState } from '../types.js';

const transitions: Record<Screen, Screen[]> = {
  home: ['workflow'],
  workflow: ['summary'],
  summary: ['home', 'workflow'],
};

export function useRouter(initialRoute?: RouteData) {
  const [screen, setScreen] = useState<Screen>(initialRoute?.screen ?? 'home');
  const [routeData, setRouteData] = useState<RouteData>(initialRoute ?? { screen: 'home' });

  function canNavigate(to: Screen): boolean {
    return transitions[screen].includes(to);
  }

  function navigate(to: Screen, data?: { feature?: string; summary?: Summary; resumeState?: WorkflowState }) {
    if (!canNavigate(to)) {
      throw new Error(`Cannot navigate from "${screen}" to "${to}"`);
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
        next = { screen: 'summary', summary: data?.summary! };
        break;
    }

    setScreen(to);
    setRouteData(next);
  }

  return { screen, routeData, navigate, canNavigate };
}
