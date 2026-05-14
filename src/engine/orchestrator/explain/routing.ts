import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { SessionLogEventEntry } from '../../../core/schemas/session-log.js';
import { narrowRecord, optionalString } from '../../../utils/type-guards.js';
import { uniqueSorted } from '../../../utils/collections.js';
import {
  type DeterministicEstimate,
  type ExplainArtifactInputs,
  type RunExplainRoute,
} from './types.js';

export function buildRoutes(opts: Pick<ExplainArtifactInputs, 'summary' | 'reviewPacket' | 'state' | 'events'>): RunExplainRoute[] {
  const routes = new Map<string, RunExplainRoute>();
  for (const task of opts.state?.tasks ?? []) {
    const route = upsertRoute(routes, task.id);
    route.title = task.title;
    route.status = task.status;
    addSource(route, 'state');
  }
  for (const estimate of opts.summary?.costPrediction?.deterministic?.tasks ?? []) {
    mergeEstimateRoute(upsertRoute(routes, estimate.taskId), estimate);
  }
  for (const routing of opts.reviewPacket?.cost.taskRouting ?? opts.summary?.taskBreakdown ?? []) {
    mergeActualRoute(upsertRoute(routes, routing.taskId), routing);
  }
  for (const event of opts.events) {
    if (event.type === 'task_started' || event.type === 'task_tokens') {
      mergeEventRoute(upsertRoute(routes, event.taskId ?? 'unknown-task'), event);
    }
  }

  return [...routes.values()]
    .map((route) => ({ ...route, notes: routeNotes(route) }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

function upsertRoute(routes: Map<string, RunExplainRoute>, taskId: string): RunExplainRoute {
  const existing = routes.get(taskId);
  if (existing) return existing;
  const route: RunExplainRoute = {
    taskId,
    title: null,
    status: null,
    method: null,
    selectedProfile: null,
    tool: null,
    model: null,
    contextFit: null,
    contextConfidence: null,
    priceConfidence: null,
    estimatedTokens: null,
    contextLength: null,
    costPosture: null,
    routingReason: null,
    sources: [],
    notes: [],
  };
  routes.set(taskId, route);
  return route;
}

function mergeEstimateRoute(route: RunExplainRoute, estimate: DeterministicEstimate['tasks'][number]): void {
  route.title = route.title ?? estimate.title;
  route.selectedProfile = route.selectedProfile ?? estimate.selectedProfileId;
  route.contextFit = route.contextFit ?? estimate.contextFit;
  route.contextConfidence = route.contextConfidence ?? estimate.contextConfidence;
  route.priceConfidence = route.priceConfidence ?? estimate.priceConfidence;
  route.estimatedTokens = route.estimatedTokens ?? estimate.estimatedPromptTokens;
  addSource(route, 'estimate');
}

function mergeActualRoute(route: RunExplainRoute, routing: TaskTokenUsage): void {
  route.title = routing.taskTitle || route.title;
  route.method = routing.method;
  route.selectedProfile = routing.implementerProfile ?? route.selectedProfile;
  route.tool = routing.tool ?? route.tool;
  route.model = routing.model ?? route.model;
  route.contextFit = routing.contextFit ?? route.contextFit;
  route.estimatedTokens = routing.estimatedTokens ?? route.estimatedTokens;
  route.contextLength = routing.contextLength ?? route.contextLength;
  route.costPosture = routing.costPosture ?? route.costPosture;
  route.routingReason = routing.routingReason ?? route.routingReason;
  if (routing.costPosture === 'unknown-price') route.priceConfidence = 'price-unknown';
  addSource(route, 'actual');
}

function mergeEventRoute(route: RunExplainRoute, event: SessionLogEventEntry): void {
  const data = narrowRecord(event.data);
  route.title = optionalString(data?.title, { trim: true, nonEmpty: true }) ?? optionalString(data?.taskTitle, { trim: true, nonEmpty: true }) ?? route.title;
  route.method = optionalString(data?.method, { trim: true, nonEmpty: true }) ?? route.method;
  route.selectedProfile = optionalString(data?.implementerProfile, { trim: true, nonEmpty: true }) ?? route.selectedProfile;
  route.tool = optionalString(data?.tool, { trim: true, nonEmpty: true }) ?? route.tool;
  route.model = optionalString(data?.model, { trim: true, nonEmpty: true }) ?? route.model;
  route.contextFit = optionalString(data?.contextFit, { trim: true, nonEmpty: true }) ?? route.contextFit;
  route.estimatedTokens = numberValue(data?.estimatedTokens) ?? route.estimatedTokens;
  route.contextLength = numberValue(data?.contextLength) ?? route.contextLength;
  route.costPosture = optionalString(data?.costPosture, { trim: true, nonEmpty: true }) ?? route.costPosture;
  route.routingReason = optionalString(data?.routingReason, { trim: true, nonEmpty: true }) ?? route.routingReason;
  addSource(route, 'session-log');
}

function routeNotes(route: RunExplainRoute): string[] {
  const notes: string[] = [];
  if (route.contextFit === 'tight') notes.push('tight context fit');
  if (route.contextFit === 'overflow') notes.push('context overflow');
  if (route.contextConfidence === 'context-conservative-fallback') notes.push('context length used conservative fallback');
  if (route.contextConfidence === 'profile-unavailable') notes.push('no usable profile context metadata');
  if (route.priceConfidence && route.priceConfidence !== 'price-known') notes.push('pricing unknown');
  if (route.costPosture?.includes('No capable')) notes.push(route.costPosture);
  if (route.routingReason) notes.push(route.routingReason);
  return uniqueSorted(notes, { trim: true, nonEmpty: true });
}

function addSource(route: RunExplainRoute, source: string): void {
  if (!route.sources.includes(source)) route.sources.push(source);
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
