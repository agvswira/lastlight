import '@fontsource-variable/manrope/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/motion.css';
import './styles/print.css';

import { renderHome } from './pages/home';
import { createIntentKey, renderCreate } from './pages/create';
import { renderPlans } from './pages/plans';
import { renderPlan } from './pages/plan';
import { renderReceive } from './pages/receive';
import { renderLaunch } from './pages/launch';
import { renderNotFound } from './pages/not-found';
import { parseRoute, navigate, type Route } from './app/router';
import { createAppState, defaultDraft, type AppState } from './app/state';
import { renderShell, bindShell } from './app/shell';
import { displayObservedTimestamp, formatDate, formatDuration, getReminderLead, hasRequiredConfirmations, isObservationFresh, readPollDelayMs, validatePolicy } from './domain/policy';
import { hasBadMixedChecksum, isAddress, isZeroAddress, normalizeAddress } from './domain/address';
import { amountHasValidPrecision, formatNativeAmount, parseNativeAmount } from './domain/amount';
import { clearLocalData, saveDraft, saveLabel, saveTransaction, setDraftPersistenceEnabled } from './storage/local';
import { downloadHandoff, downloadHandoffJson } from './exports/handoff';
import { buildReminderIcs, buildRecipientIcs, downloadText } from './exports/calendar';
import { downloadReceipt } from './exports/receipt';
import { chains, manifests, isSupportedChain, DEFAULT_CHAIN, MAINNET_ONLY, type DeploymentManifest } from './app/config';
import { diagnosticDetails, icon, escapeHtml } from './components/ui';
import { renderActionDialog } from './components/action-dialog';
import { animateCreateStep, animateRoutePresentation, disposeRoutePresentation } from './components/motion';
import type { DurationUnit, Plan, TransactionState } from './domain/types';
import type { ReadBlock } from './chain/read';

type RenderProof = typeof import('./pages/proof')['renderProof'];

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) throw new Error('Lastlight app root is missing.');
const root: HTMLDivElement = appRoot;

const state = createAppState();
let lastRoute = parseRoute();
let renderedHash = window.location.hash;
let renderedCreateStep: number | null = null;
let activeHydrationKey: string | null = null;
let activeListHydrationKey: string | null = null;
let loadedListKey: string | null = null;
let livePlanHydrationGeneration = 0;
let listHydrationGeneration = 0;
let renderedListContextKey: string | null = null;
let livePollTimer: number | undefined;
const livePlanReadFailures = new Map<string, number>();
const liveListReadFailures = new Map<string, number>();
let activeBalanceKey: string | null = null;
let loadedBalanceKey: string | null = null;
let activeCreateClockKey: string | null = null;
let loadedCreateClockKey: string | null = null;
let activeCreateFeeKey: string | null = null;
let activeActionFeeKey: string | null = null;
let activePlanAction: Promise<boolean> | undefined;
let walletWriteBusy = false;
let renderComponentGallery: (() => string) | undefined;
let renderProofPage: RenderProof | undefined;
let proofPageLoad: Promise<void> | undefined;
let proofPageLoadError = false;

type FocusSnapshot = {
  id?: string;
  kind?: 'draft' | 'plan-action' | 'plan-role';
  value?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
};

function snapshotFocus(): FocusSnapshot | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return undefined;
  const input = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : undefined;
  const selectionStart = input?.selectionStart;
  const selectionEnd = input?.selectionEnd;
  if (active.id) return { id: active.id, selectionStart, selectionEnd };
  const datasets: Array<[FocusSnapshot['kind'], string | undefined]> = [
    ['draft', active.dataset.draftField],
    ['plan-action', active.dataset.planAction],
    ['plan-role', active.dataset.planRole],
  ];
  const match = datasets.find(([, value]) => value);
  return match ? { kind: match[0], value: match[1], selectionStart, selectionEnd } : undefined;
}

function restoreFocus(snapshot: FocusSnapshot | undefined): void {
  if (!snapshot) return;
  let target: HTMLElement | null = snapshot.id ? document.getElementById(snapshot.id) : null;
  if (!target && snapshot.kind && snapshot.value) {
    const attribute = snapshot.kind === 'draft' ? 'data-draft-field' : snapshot.kind === 'plan-action' ? 'data-plan-action' : 'data-plan-role';
    const datasetKey = snapshot.kind === 'draft' ? 'draftField' : snapshot.kind === 'plan-action' ? 'planAction' : 'planRole';
    target = Array.from(document.querySelectorAll<HTMLElement>(`[${attribute}]`)).find((element) => element.dataset[datasetKey] === snapshot.value) ?? null;
  }
  if (!target) return;
  target.focus({ preventScroll: true });
  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && snapshot.selectionStart !== undefined && snapshot.selectionStart !== null) {
    try { target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd ?? snapshot.selectionStart); } catch { /* some input types do not support selection */ }
  }
}

function routeKey(route: Route): string {
  return `${route.name}:${route.chainId ?? ''}:${route.contract?.toLowerCase() ?? ''}:${route.vaultId?.toString() ?? ''}`;
}

function retainSameBlockObservation(previous: Plan | undefined, next: Plan): Plan {
  if (!previous?.observation || !next.observation) return next;
  if (previous.observation.blockNumber !== next.observation.blockNumber || previous.observation.blockHash !== next.observation.blockHash) return next;
  return { ...next, observation: { ...next.observation, receivedAtMonotonicMs: previous.observation.receivedAtMonotonicMs } };
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : typeof error.cause === 'string' ? error.cause : '';
    return `${error.message} ${cause}`;
  }
  return String(error);
}

function isHistoricalSnapshotUnavailable(error: unknown): boolean {
  return /historical|pruned|missing trie|unknown block|block not found|header not found|state unavailable|state is not available|not available at block/i.test(errorText(error));
}

function allowlistedManifest(route: Route): DeploymentManifest | undefined {
  if (!route.chainId || !isSupportedChain(route.chainId) || !route.contract) return undefined;
  if (MAINNET_ONLY && route.chainId !== 677) return undefined;
  const manifest = manifests[route.chainId];
  return manifest.contractAddress?.toLowerCase() === route.contract.toLowerCase() ? manifest : undefined;
}

function isLivePlanRoute(route: Route): boolean {
  return (route.name === 'plan' || route.name === 'receive' || route.name === 'proof') && Boolean(route.vaultId && allowlistedManifest(route));
}

function activePlanFor(route: Route): Plan | undefined {
  const plan = state.activePlan;
  return plan && route.chainId === plan.chainId && route.contract?.toLowerCase() === plan.contract.toLowerCase() && route.vaultId === plan.vaultId ? plan : undefined;
}

type ReadPlan = (chainId: Plan['chainId'], vaultId: bigint, snapshot?: ReadBlock) => Promise<Plan | null>;

async function readPlanRows(readPlan: ReadPlan, chainId: Plan['chainId'], ids: bigint[], snapshot: ReadBlock): Promise<Array<PromiseSettledResult<Plan | null>>> {
  const results: Array<PromiseSettledResult<Plan | null>> = new Array(ids.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= ids.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await readPlan(chainId, ids[index], snapshot) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, () => worker()));
  return results;
}

function currentListContextKey(): string | null {
  const { account, chainId } = state.wallet;
  if (!account || !chainId || (MAINNET_ONLY && chainId !== 677)) return null;
  return `${chainId}:${account.toLowerCase()}:${state.planRole}`;
}

function invalidateLivePlanHydration(): void {
  livePlanHydrationGeneration += 1;
  activeHydrationKey = null;
}

function invalidateListHydration(): void {
  listHydrationGeneration += 1;
  activeListHydrationKey = null;
}

function listRequestIsCurrent(key: string, generation: number): boolean {
  return listHydrationGeneration === generation && activeListHydrationKey === key && currentListContextKey() === key;
}

function loadProofPage(): void {
  if (renderProofPage || proofPageLoad) return;
  proofPageLoad = import('./pages/proof').then((module) => {
    renderProofPage = module.renderProof;
    proofPageLoad = undefined;
    proofPageLoadError = false;
    if (parseRoute().name === 'proof') render();
  }).catch(() => {
    proofPageLoad = undefined;
    proofPageLoadError = true;
    if (parseRoute().name === 'proof') render();
  });
}

function renderProofLoading(): string {
  return `<div class="not-found shell-width"><div class="not-found__mark">${icon('clock')}</div><p class="eyebrow">Proof view</p><h1>Loading the proof view.</h1><p>The receipt and observed block details are being prepared without requesting a wallet.</p><div class="loading-bar" aria-hidden="true"></div></div>`;
}

function renderProofError(): string {
  return `<div class="not-found shell-width"><div class="not-found__mark">${icon('warning')}</div><p class="eyebrow">Proof view unavailable</p><h1>We couldn’t load the proof view.</h1><p>The current plan is unchanged. Retry the local page asset or return home.</p><div><button class="button button--primary" type="button" data-retry-proof>Retry proof view ${icon('arrow')}</button><a class="button button--secondary" href="#/">Back home</a></div></div>`;
}

function pageForRoute(route: Route): string {
  switch (route.name) {
    case 'home': return renderHome(state);
    case 'create': return renderCreate(state);
    case 'plans': return renderPlans(state);
    case 'plan': return activePlanFor(route) ? renderPlan(state, activePlanFor(route)!) : isLivePlanRoute(route) ? renderLiveLoading('Loading this plan from the selected deployment') : renderUnsupportedLocator(route);
    case 'receive': return activePlanFor(route) ? renderReceive(state, activePlanFor(route)!) : isLivePlanRoute(route) ? renderLiveLoading('Loading the recipient view from the selected deployment') : renderUnsupportedLocator(route);
    case 'proof': {
      const activePlan = activePlanFor(route);
      if (activePlan || isLivePlanRoute(route)) {
        if (!renderProofPage) {
          loadProofPage();
          return proofPageLoadError ? renderProofError() : renderProofLoading();
        }
        return activePlan
          ? renderProofPage(activePlan, state.activePlanError ? { message: state.activePlanError, diagnostic: state.activePlanDiagnostic } : undefined)
          : renderLiveLoading('Loading proof from the selected deployment');
      }
      return renderUnsupportedLocator(route);
    }
    case 'launch': return renderLaunch();
    case 'not-found': return renderNotFound();
  }
  if (import.meta.env.DEV && route.name === 'component-gallery') return renderComponentGallery ? renderComponentGallery() : renderNotFound();
  return renderNotFound();
}

function renderLiveLoading(label: string): string {
  return `<div class="not-found shell-width"><div class="not-found__mark">${icon('clock')}</div><p class="eyebrow">Fresh chain read</p><h1>${escapeHtml(label)}.</h1><p>Eligibility comes from an observed block timestamp. The page will not use your device clock or show a cached action while the read is pending.</p><div class="loading-bar" aria-hidden="true"></div></div>`;
}

function renderLiveError(error: unknown): string {
  const message = isHistoricalSnapshotUnavailable(error)
    ? 'The selected RPC cannot serve the requested historical snapshot. Retry the read when the network responds.'
    : 'The selected deployment did not return a usable plan. Retry the read when the network responds.';
  return `<div class="not-found shell-width"><div class="not-found__mark">${icon('warning')}</div><p class="eyebrow">Plan read unavailable</p><h1>We couldn’t refresh this plan.</h1><p>${escapeHtml(message)}</p>${diagnosticDetails(error)}<div><button class="button button--primary" type="button" data-retry-live>Retry read ${icon('arrow')}</button><a class="button button--secondary" href="#/">Back home</a></div></div>`;
}

function renderUnsupportedLocator(route: Route): string {
  const network = route.chainId && route.chainId in chains ? chains[route.chainId as keyof typeof chains].name : 'Unknown network';
  if (MAINNET_ONLY && route.chainId !== 677) return `<div class="not-found shell-width"><div class="not-found__mark">${icon('warning')}</div><h1>This link is for another network.</h1><p>The public Lastlight app now uses BOT Chain Mainnet.</p><a class="button button--primary" href="#/plans">Go to My plans ${icon('arrow')}</a></div>`;
  const routeName = route.name === 'receive' || route.name === 'proof' || route.name === 'plan' ? route.name : 'plan';
  return `<div class="not-found shell-width"><div class="not-found__mark">${icon('warning')}</div><p class="eyebrow">Plan unavailable</p><h1>This plan is not available here.</h1><p>Lastlight did not load or infer data for ${escapeHtml(network)}. The requested contract <code>${escapeHtml(route.contract ?? 'missing')}</code> and plan <code>${escapeHtml(route.vaultId ?? 'missing')}</code> are not backed by a configured deployment in this workspace.</p><form class="locator-form" data-locator-route="${routeName}"><div class="field"><label class="field__label" for="locator-chain">Network</label><select id="locator-chain" name="chain">${MAINNET_ONLY ? '' : `<option value="968" ${route.chainId === 968 ? 'selected' : ''}>BOT Testnet · 968</option>`}<option value="677" ${route.chainId === 677 ? 'selected' : ''}>BOT Mainnet · 677</option></select></div><div class="field"><label class="field__label" for="locator-contract">Contract address</label><input id="locator-contract" name="contract" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="0x…" value="${escapeHtml(route.contract ?? '')}"></div><div class="field"><label class="field__label" for="locator-id">Plan ID</label><input id="locator-id" name="id" type="text" inputmode="numeric" pattern="[1-9][0-9]*" value="${escapeHtml(route.vaultId ?? '')}"></div><button class="button button--primary" type="submit">Check locator ${icon('arrow')}</button></form><div>${`<a class="button button--secondary" href="#/">${icon('arrow')}<span>Back to overview</span></a>`}${`<a class="button button--quiet" href="#/?section=how-it-works">${icon('external')}<span>How it works</span></a>`}</div></div>`;
}

function render(options: { focus?: string } = {}): void {
  if (/^#\/?demo(?:[/?]|$)/i.test(window.location.hash)) {
    navigate('/create');
    return;
  }
  if (/^#\/?about(?:[/?]|$)/i.test(window.location.hash)) {
    navigate('/?section=how-it-works');
    return;
  }
  const currentHash = window.location.hash;
  const hashChanged = currentHash !== renderedHash;
  const firstRender = !root.firstElementChild;
  const nextRoute = parseRoute();
  if (MAINNET_ONLY && nextRoute.name === 'plans' && nextRoute.chainId && nextRoute.chainId !== 677) {
    navigate('/plans');
    return;
  }
  if (nextRoute.name === 'plans' && nextRoute.chainId && !state.wallet.connected && state.wallet.chainId !== nextRoute.chainId) {
    state.wallet = { ...state.wallet, chainId: nextRoute.chainId };
    state.activePlan = undefined;
    state.activePlanError = undefined;
    state.activePlanDiagnostic = undefined;
    state.livePlans = [];
    state.plansLoadedIds = [];
    state.plansNextOffset = 0n;
    state.plansQuery = '';
    state.plansTotal = 0n;
    state.plansObservedBlock = undefined;
    state.planRowErrors = {};
    state.planRowDiagnostics = {};
    state.plansDiagnostic = undefined;
    invalidateListHydration();
    loadedListKey = null;
  }
  const changed = routeKey(nextRoute) !== routeKey(lastRoute);
  const createStepChanged = !changed && nextRoute.name === 'create' && renderedCreateStep !== null && renderedCreateStep !== state.draft.step;
  const sectionNavigation = Boolean(nextRoute.name === 'home' && nextRoute.section && (changed || hashChanged || firstRender));
  const nextListContextKey = currentListContextKey();
  const previousFocus = snapshotFocus();
  const previousScroll = { x: window.scrollX, y: window.scrollY };
  if (changed) document.querySelectorAll<HTMLDialogElement>('.action-dialog').forEach((dialog) => dialog.remove());
  if (changed) invalidateLivePlanHydration();
  if (changed && lastRoute.name === 'plans' && nextRoute.name !== 'plans') invalidateListHydration();
  if (nextListContextKey !== renderedListContextKey) {
    invalidateListHydration();
    renderedListContextKey = nextListContextKey;
  }
  if (changed && !isLivePlanRoute(nextRoute)) {
    state.activePlan = undefined;
    state.activePlanError = undefined;
    state.activePlanDiagnostic = undefined;
  }
  lastRoute = nextRoute;
  renderedHash = currentHash;
  renderedCreateStep = nextRoute.name === 'create' ? state.draft.step : null;
  const content = pageForRoute(lastRoute);
  const shouldAnimate = changed || firstRender;
  const shellRouteName = lastRoute.name === 'home' && lastRoute.section === 'how-it-works' ? 'how-it-works' : lastRoute.name;
  root.innerHTML = renderShell(content, state, shellRouteName, lastRoute.chainId);
  bindShell(state, render);
  bindPageEvents();
  if (shouldAnimate) void animateRoutePresentation(root);
  else if (createStepChanged) animateCreateStep(root);
  const main = document.querySelector<HTMLElement>('#main-content');
  if (options.focus) document.getElementById(options.focus)?.focus();
  else if (sectionNavigation && lastRoute.section) {
    const sectionId = lastRoute.section;
    window.requestAnimationFrame(() => {
      const section = document.getElementById(sectionId);
      section?.querySelector<HTMLElement>('#process-heading')?.focus({ preventScroll: true });
      section?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    });
  }
  else if (changed && main && lastRoute.name !== 'home') main.focus({ preventScroll: true });
  else if (!changed) {
    restoreFocus(previousFocus);
    window.scrollTo(previousScroll.x, previousScroll.y);
  }
  if (isLivePlanRoute(lastRoute) && !activePlanFor(lastRoute)) void hydrateLivePlan(lastRoute);
  if (lastRoute.name === 'plans' && state.wallet.connected) void hydrateLivePlans();
  if ((lastRoute.name === 'create' || lastRoute.name === 'receive') && state.wallet.connected) void hydrateWalletBalance();
  if (lastRoute.name === 'create' && state.wallet.connected) {
    void hydrateCreateChainObservation();
    void hydrateCreateFeeEstimate();
  }
  if (lastRoute.name === 'receive' && state.wallet.connected && activePlanFor(lastRoute)) void hydrateRecipientFeeEstimate(activePlanFor(lastRoute)!);
  if (import.meta.env.DEV && lastRoute.name === 'component-gallery') void loadDevelopmentGallery();
  configureLivePolling(lastRoute);
}

async function loadDevelopmentGallery(): Promise<void> {
  if (!import.meta.env.DEV || renderComponentGallery) return;
  const gallery = await import('./pages/component-gallery');
  renderComponentGallery = gallery.renderComponentGallery;
  if (parseRoute().name === 'component-gallery') render();
}

function configureLivePolling(route: Route): void {
  if (livePollTimer !== undefined) window.clearInterval(livePollTimer);
  livePollTimer = undefined;
  if (document.visibilityState === 'hidden') return;
  if (isLivePlanRoute(route) && activePlanFor(route)) {
    const delay = readPollDelayMs(livePlanReadFailures.get(routeKey(route)) ?? 0);
    livePollTimer = window.setInterval(() => { void hydrateLivePlan(route); }, delay);
  } else if (route.name === 'plans' && state.wallet.connected) {
    const key = currentListContextKey();
    const delay = readPollDelayMs(key ? liveListReadFailures.get(key) ?? 0 : 0);
    livePollTimer = window.setInterval(() => { void hydrateLivePlans(true, true); }, delay);
  } else if (route.name === 'create' && state.wallet.connected) {
    livePollTimer = window.setInterval(() => { void hydrateCreateChainObservation(); }, 5_000);
  }
}

async function hydrateLivePlan(route: Route): Promise<void> {
  if (!route.chainId || !isSupportedChain(route.chainId) || !route.vaultId || !route.contract) return;
  const key = routeKey(route);
  if (activeHydrationKey === key) return;
  const generation = ++livePlanHydrationGeneration;
  activeHydrationKey = key;
  try {
    const { readPlan } = await import('./chain/read');
    const plan = await readPlan(route.chainId, route.vaultId);
    if (!plan || plan.contract.toLowerCase() !== route.contract.toLowerCase()) throw new Error('This plan was not returned by the selected deployment.');
    if (livePlanHydrationGeneration !== generation || routeKey(parseRoute()) !== key) return;
    livePlanReadFailures.delete(key);
    state.activePlanError = undefined;
    state.activePlanDiagnostic = undefined;
    state.activePlan = retainSameBlockObservation(state.activePlan, plan);
    if (routeKey(parseRoute()) === key) render();
  } catch (error) {
    if (livePlanHydrationGeneration !== generation || routeKey(parseRoute()) !== key) return;
    livePlanReadFailures.set(key, Math.min((livePlanReadFailures.get(key) ?? 0) + 1, 3));
    if (routeKey(parseRoute()) === key && !activePlanFor(route)) {
      root.innerHTML = renderShell(renderLiveError(error), state, route.name, route.chainId);
      bindShell(state, render);
      bindPageEvents();
    } else if (routeKey(parseRoute()) === key) {
      state.activePlanError = isHistoricalSnapshotUnavailable(error)
        ? 'The selected RPC cannot serve the latest historical snapshot. The last successful observation remains visible until a fresh read succeeds.'
        : 'The latest chain read failed. The last successful observation remains visible until a fresh read succeeds.';
      state.activePlanDiagnostic = errorText(error);
      render();
    }
  } finally {
    if (livePlanHydrationGeneration === generation) activeHydrationKey = null;
  }
}

async function hydrateLivePlans(force = false, quiet = false, snapshotRetry = 0): Promise<void> {
  const account = state.wallet.account;
  const chainId = state.wallet.chainId;
  if (!account || !chainId || !isSupportedChain(chainId) || (MAINNET_ONLY && chainId !== 677) || !manifests[chainId].contractAddress) return;
  const key = `${chainId}:${account.toLowerCase()}:${state.planRole}`;
  if (activeListHydrationKey === key || (!force && loadedListKey === key)) return;
  const generation = ++listHydrationGeneration;
  activeListHydrationKey = key;
  if (!quiet) state.plansLoading = true;
  try {
    const { readPlan, readPlanIds } = await import('./chain/read');
    const loaded = await readPlanIds(chainId, account, state.planRole, 0n, 20n);
    if (!listRequestIsCurrent(key, generation)) return;
    state.plansTotal = loaded.total;
    state.plansObservedBlock = loaded.observedBlock;
    const firstPageStable = quiet && BigInt(state.plansLoadedIds.length) <= loaded.total && state.plansLoadedIds.length >= loaded.ids.length && loaded.ids.every((id, index) => state.plansLoadedIds[index] === id);
    const ids = firstPageStable ? state.plansLoadedIds : loaded.ids;
    if (!firstPageStable) {
      state.plansLoadedIds = [...loaded.ids];
      state.plansNextOffset = BigInt(loaded.ids.length);
    }
    const previousPlans = new Map(state.livePlans.map((plan) => [plan.vaultId.toString(), plan]));
    const results = await readPlanRows(readPlan, chainId, ids, loaded.observedBlock);
    if (!listRequestIsCurrent(key, generation)) return;
    if (snapshotRetry === 0 && results.some((result) => result.status === 'rejected' && isHistoricalSnapshotUnavailable(result.reason))) {
      invalidateListHydration();
      await hydrateLivePlans(true, quiet, 1);
      return;
    }
    const rowErrors = { ...state.planRowErrors };
    const rowDiagnostics = { ...state.planRowDiagnostics };
    results.forEach((result, index) => {
      const id = ids[index].toString();
      if (result.status === 'rejected') {
        rowErrors[id] = 'This row could not be refreshed from the selected RPC.';
        rowDiagnostics[id] = errorText(result.reason);
      } else {
        delete rowErrors[id];
        delete rowDiagnostics[id];
      }
    });
    state.planRowErrors = rowErrors;
    state.planRowDiagnostics = rowDiagnostics;
    state.livePlans = results.flatMap((result) => result.status === 'fulfilled' && result.value ? [retainSameBlockObservation(previousPlans.get(result.value.vaultId.toString()), result.value)] : []);
    const firstRowFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    state.plansError = firstRowFailure ? 'Some loaded plans could not be refreshed. Other rows remain available.' : undefined;
    state.plansDiagnostic = firstRowFailure ? errorText(firstRowFailure.reason) : undefined;
    if (state.plansError) liveListReadFailures.set(key, Math.min((liveListReadFailures.get(key) ?? 0) + 1, 3));
    else liveListReadFailures.delete(key);
    state.plansLoading = false;
    loadedListKey = key;
    if (routeKey(parseRoute()) === routeKey({ name: 'plans' })) render();
  } catch (error) {
    if (!listRequestIsCurrent(key, generation)) return;
    state.plansLoading = false;
    state.plansError = isHistoricalSnapshotUnavailable(error)
      ? 'The selected RPC cannot serve the requested historical snapshot. Retry the list read when the network responds.'
      : 'Could not load this wallet’s plan list. Retry the read when the network responds.';
    state.plansDiagnostic = errorText(error);
    liveListReadFailures.set(key, Math.min((liveListReadFailures.get(key) ?? 0) + 1, 3));
    if (parseRoute().name === 'plans') render();
  } finally {
    if (listRequestIsCurrent(key, generation)) activeListHydrationKey = null;
  }
}

function walletBalanceKey(): string | null {
  if (!state.wallet.connected || !state.wallet.account || !isSupportedChain(state.wallet.chainId) || (MAINNET_ONLY && state.wallet.chainId !== 677)) return null;
  return `${state.walletBalanceVersion}:${state.wallet.chainId}:${state.wallet.account.toLowerCase()}`;
}

function createChainId(): 968 | 677 | 31337 {
  return MAINNET_ONLY ? 677 : isSupportedChain(state.wallet.chainId) ? state.wallet.chainId : DEFAULT_CHAIN;
}

async function hydrateCreateChainObservation(): Promise<void> {
  if (parseRoute().name !== 'create' || !state.wallet.connected) return;
  const chainId = createChainId();
  const key = `${chainId}:${state.wallet.account?.toLowerCase() ?? 'disconnected'}`;
  if (activeCreateClockKey === key || (loadedCreateClockKey === key && isObservationFresh(state.createChainObservation))) return;
  activeCreateClockKey = key;
  try {
    const { readFreshBlock } = await import('./chain/clock');
    const observation = await readFreshBlock(chainId);
    if (parseRoute().name !== 'create' || createChainId() !== chainId) return;
    state.createChainObservation = observation;
    loadedCreateClockKey = key;
    render();
  } catch {
    if (parseRoute().name === 'create' && createChainId() === chainId) {
      state.createChainObservation = undefined;
      loadedCreateClockKey = key;
      render();
    }
  } finally {
    if (activeCreateClockKey === key) activeCreateClockKey = null;
  }
}

async function hydrateCreateFeeEstimate(): Promise<void> {
  if (parseRoute().name !== 'create' || !state.wallet.connected || !state.wallet.account || state.draft.step < 2) return;
  if (MAINNET_ONLY && state.wallet.chainId !== 677) return;
  const chainId = createChainId();
  const intentKey = createIntentKey(state, chainId);
  const recipient = normalizeAddress(state.draft.recipient);
  const amount = parseNativeAmount(state.draft.amount);
  if (!intentKey || !recipient || !amount || !isSupportedChain(chainId)) return;
  if (state.createFeeEstimate?.intentKey === intentKey || activeCreateFeeKey === intentKey) return;
  if (!manifests[chainId].contractAddress || manifests[chainId].verificationStatus !== 'verified') return;
  activeCreateFeeKey = intentKey;
  state.createFeeEstimateLoading = true;
  state.createFeeEstimateError = undefined;
  try {
    const { estimateVaultAction } = await import('./chain/write');
    const { getInjectedProvider } = await import('./chain/wallet');
    const estimate = await estimateVaultAction(chainId, state.wallet.account, {
      kind: 'create', successor: recipient, inactivityPeriod: BigInt(state.draft.inactivityPeriod), gracePeriod: BigInt(state.draft.gracePeriod), value: amount,
    }, getInjectedProvider(), intentKey);
    if (createIntentKey(state, chainId) === intentKey && state.wallet.account) state.createFeeEstimate = estimate;
  } catch (error) {
    if (createIntentKey(state, chainId) === intentKey) state.createFeeEstimateError = error instanceof Error ? error.message : 'Fee estimate unavailable.';
  } finally {
    if (activeCreateFeeKey === intentKey) activeCreateFeeKey = null;
    if (createIntentKey(state, chainId) === intentKey) {
      state.createFeeEstimateLoading = false;
      if (parseRoute().name === 'create') render();
    }
  }
}

function recipientClaimIntentKey(plan: Plan, account: string): string {
  return `claim:${plan.chainId}:${plan.contract.toLowerCase()}:${account.toLowerCase()}:${plan.vaultId.toString()}:${plan.successor.toLowerCase()}`;
}

function planActionIntentKey(plan: Plan, account: string, action: 'heartbeat' | 'change-successor' | 'cancel' | 'claim', target?: string): string {
  return `${plan.chainId}:${plan.contract.toLowerCase()}:${account.toLowerCase()}:${plan.vaultId.toString()}:${action}:${target?.toLowerCase() ?? ''}`;
}

async function hydrateRecipientFeeEstimate(plan: Plan): Promise<void> {
  const account = state.wallet.account;
  if (parseRoute().name !== 'receive' || !account || state.wallet.chainId !== plan.chainId || plan.status !== 'CLAIMABLE' || account.toLowerCase() !== plan.successor.toLowerCase()) return;
  const intentKey = recipientClaimIntentKey(plan, account);
  if (state.actionFeeEstimate?.intentKey === intentKey || activeActionFeeKey === intentKey) return;
  activeActionFeeKey = intentKey;
  state.actionFeeEstimateLoading = true;
  state.actionFeeEstimateError = undefined;
  try {
    const { estimateVaultAction } = await import('./chain/write');
    const { getInjectedProvider } = await import('./chain/wallet');
    const estimate = await estimateVaultAction(plan.chainId, account, { kind: 'claim', vaultId: plan.vaultId, recipient: plan.successor }, getInjectedProvider(), intentKey);
    if (parseRoute().name === 'receive' && activePlanFor(parseRoute())?.vaultId === plan.vaultId) state.actionFeeEstimate = estimate;
  } catch (error) {
    if (parseRoute().name === 'receive' && activePlanFor(parseRoute())?.vaultId === plan.vaultId) state.actionFeeEstimateError = error instanceof Error ? error.message : 'Fee estimate unavailable.';
  } finally {
    if (activeActionFeeKey === intentKey) activeActionFeeKey = null;
    if (parseRoute().name === 'receive' && activePlanFor(parseRoute())?.vaultId === plan.vaultId) {
      state.actionFeeEstimateLoading = false;
      render();
    }
  }
}

async function hydrateWalletBalance(): Promise<void> {
  const key = walletBalanceKey();
  if (!key || activeBalanceKey === key || loadedBalanceKey === key) return;
  const chainId = state.wallet.chainId as 968 | 677 | 31337;
  const account = state.wallet.account!;
  activeBalanceKey = key;
  state.walletBalanceLoading = true;
  state.walletBalanceError = undefined;
  try {
    const { readNativeBalance } = await import('./chain/read');
    const balance = await readNativeBalance(chainId, account);
    if (walletBalanceKey() === key) state.walletBalance = balance;
  } catch (error) {
    if (walletBalanceKey() === key) {
      state.walletBalance = undefined;
      state.walletBalanceError = error instanceof Error ? 'Balance read unavailable on this network.' : 'Balance read unavailable.';
    }
  } finally {
    if (walletBalanceKey() === key) {
      state.walletBalanceLoading = false;
      loadedBalanceKey = key;
      if (parseRoute().name === 'create' || parseRoute().name === 'receive') render();
    }
    if (activeBalanceKey === key) activeBalanceKey = null;
  }
}

async function loadMorePlans(snapshotRetry = 0): Promise<void> {
  const account = state.wallet.account;
  const chainId = state.wallet.chainId;
  if (!account || !chainId || !isSupportedChain(chainId) || !manifests[chainId].contractAddress || state.plansLoading || activeListHydrationKey || state.plansNextOffset >= state.plansTotal) return;
  const key = `${chainId}:${account.toLowerCase()}:${state.planRole}`;
  const generation = ++listHydrationGeneration;
  activeListHydrationKey = key;
  state.plansLoading = true;
  render();
  const requestedSnapshot = state.plansObservedBlock;
  try {
    const { readPlan, readPlanIds } = await import('./chain/read');
    const page = await readPlanIds(chainId, account, state.planRole, state.plansNextOffset, 20n, state.plansObservedBlock);
    if (!listRequestIsCurrent(key, generation)) return;
    state.plansTotal = page.total;
    state.plansObservedBlock = page.observedBlock;
    const results = await readPlanRows(readPlan, chainId, page.ids, page.observedBlock);
    if (!listRequestIsCurrent(key, generation)) return;
    if (snapshotRetry === 0 && requestedSnapshot && results.some((result) => result.status === 'rejected' && isHistoricalSnapshotUnavailable(result.reason))) {
      invalidateListHydration();
      await hydrateLivePlans(true, true);
      await loadMorePlans(1);
      return;
    }
    const rowErrors = { ...state.planRowErrors };
    const rowDiagnostics = { ...state.planRowDiagnostics };
    results.forEach((result, index) => {
      const id = page.ids[index].toString();
      if (result.status === 'rejected') {
        rowErrors[id] = 'This row could not be refreshed from the selected RPC.';
        rowDiagnostics[id] = errorText(result.reason);
      } else {
        delete rowErrors[id];
        delete rowDiagnostics[id];
      }
    });
    state.planRowErrors = rowErrors;
    state.planRowDiagnostics = rowDiagnostics;
    state.plansLoadedIds = [...state.plansLoadedIds, ...page.ids];
    state.plansNextOffset += BigInt(page.ids.length);
    state.livePlans = [...state.livePlans, ...results.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : [])];
    const firstRowFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    state.plansError = firstRowFailure ? 'Some rows could not be refreshed. Loaded rows remain available.' : undefined;
    state.plansDiagnostic = firstRowFailure ? errorText(firstRowFailure.reason) : undefined;
  } catch (error) {
    if (!listRequestIsCurrent(key, generation)) return;
    if (snapshotRetry === 0 && requestedSnapshot && isHistoricalSnapshotUnavailable(error)) {
      invalidateListHydration();
      await hydrateLivePlans(true, true);
      await loadMorePlans(1);
      return;
    }
    state.plansError = isHistoricalSnapshotUnavailable(error)
      ? 'The selected RPC cannot serve the requested historical snapshot. Retry loading this page when the network responds.'
      : 'Could not load another page. Retry when the network responds.';
    state.plansDiagnostic = errorText(error);
  } finally {
    if (listRequestIsCurrent(key, generation)) {
      state.plansLoading = false;
      activeListHydrationKey = null;
      if (parseRoute().name === 'plans') render();
    }
  }
}

async function retryPlanRow(id: bigint): Promise<void> {
  const account = state.wallet.account;
  const chainId = state.wallet.chainId;
  if (!account || !chainId || !isSupportedChain(chainId) || !manifests[chainId].contractAddress) return;
  if (activeListHydrationKey) {
    showTray('List refresh in progress', 'Wait for the current chain snapshot before retrying this row.', 'info');
    return;
  }
  const key = id.toString();
  const contextKey = currentListContextKey();
  if (!contextKey) return;
  const generation = ++listHydrationGeneration;
  activeListHydrationKey = contextKey;
  delete state.planRowErrors[key];
  delete state.planRowDiagnostics[key];
  render();
  try {
    const { readPlan } = await import('./chain/read');
    const plan = await readPlan(chainId, id, state.plansObservedBlock);
    if (!plan) throw new Error('The plan was not returned by the selected deployment.');
    if (!listRequestIsCurrent(contextKey, generation)) return;
    state.livePlans = [...state.livePlans.filter((entry) => entry.vaultId !== id), plan];
  } catch (error) {
    if (!listRequestIsCurrent(contextKey, generation)) return;
    state.planRowErrors[key] = 'This row could not be refreshed from the selected RPC.';
    state.planRowDiagnostics[key] = errorText(error);
  }
  if (listRequestIsCurrent(contextKey, generation)) {
    activeListHydrationKey = null;
    if (parseRoute().name === 'plans') render();
  }
}

function updateDraft(mutator: (draft: AppState['draft']) => void, rerender = true): void {
  mutator(state.draft);
  state.draft.acknowledgements = [...state.draft.acknowledgements] as [boolean, boolean];
  persistDraft();
  state.createFeeEstimate = undefined;
  state.createFeeEstimateError = undefined;
  state.createFeeEstimateLoading = false;
  if (rerender) render();
}

function persistDraft(): void {
  if (!saveDraft(state.draft, state.draftPersistenceEnabled)) state.storageAvailable = false;
}

function isConfiguredDefaultContract(value: string): boolean {
  const selectedChainId = createChainId();
  const configured = manifests[selectedChainId].contractAddress;
  return Boolean(configured && value.toLowerCase() === configured.toLowerCase());
}

function shortTimingRequired(): boolean {
  const selectedChainId = createChainId();
  return selectedChainId === 677 && (state.draft.inactivityPeriod < 30 * 24 * 60 * 60 || state.draft.gracePeriod < 7 * 24 * 60 * 60);
}

function validationForStep(step: number): boolean {
  const draft = state.draft;
  if (step === 0) return isAddress(draft.recipient) && !hasBadMixedChecksum(draft.recipient) && !isZeroAddress(draft.recipient) && !isConfiguredDefaultContract(draft.recipient) && (!state.wallet.account || draft.recipient.toLowerCase() !== state.wallet.account.toLowerCase());
  if (step === 1) return validatePolicy(draft.inactivityPeriod, draft.gracePeriod).length === 0;
  if (step === 2) return amountHasValidPrecision(draft.amount) && parseNativeAmount(draft.amount) !== 0n;
  return validatePolicy(draft.inactivityPeriod, draft.gracePeriod).length === 0 && isAddress(draft.recipient) && !hasBadMixedChecksum(draft.recipient) && !isZeroAddress(draft.recipient) && !isConfiguredDefaultContract(draft.recipient) && (!state.wallet.account || draft.recipient.toLowerCase() !== state.wallet.account.toLowerCase()) && amountHasValidPrecision(draft.amount) && parseNativeAmount(draft.amount) !== 0n && state.draft.acknowledgements.every(Boolean) && (!shortTimingRequired() || state.draft.shortTimingAcknowledgement === true);
}

function showTray(title: string, message: string, tone: 'warning' | 'info' | 'success' = 'info', action?: { label: string; onClick: () => void | Promise<void> }, diagnostic?: unknown): void {
  const tray = document.querySelector<HTMLDivElement>('#transaction-tray');
  if (!tray) return;
  tray.hidden = false;
  tray.innerHTML = `<div class="tray-inner tray-inner--${tone}"><span class="tray-icon">${icon(tone === 'warning' ? 'warning' : tone === 'success' ? 'check' : 'clock')}</span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span>${diagnosticDetails(diagnostic)}</div>${action ? `<button class="tray-action" type="button">${escapeHtml(action.label)}</button>` : ''}<button class="tray-close" type="button" aria-label="Dismiss notification">×</button></div>`;
  tray.querySelector('.tray-close')?.addEventListener('click', () => { tray.hidden = true; });
  tray.querySelector('.tray-action')?.addEventListener('click', () => { void action?.onClick(); });
}

function recordTransaction(key: string, transaction: TransactionState): void {
  const existing = state.transactions.findIndex((entry) => entry.key === key);
  const merged = existing >= 0 ? { ...state.transactions[existing].transaction, ...transaction } : transaction;
  saveTransaction(key, merged);
  const entry = { key, transaction: merged };
  if (existing >= 0) state.transactions[existing] = entry;
  else state.transactions.unshift(entry);
}

function isPendingTransactionStatus(status: TransactionState['status']): boolean {
  return ['validating', 'simulating', 'review-ready', 'awaiting-wallet', 'submitted', 'confirming', 'unknown', 'pending-timeout', 'broadcast-unknown', 'repriced', 'replaced', 'reorged'].includes(status);
}

function transactionNeedsReconciliation(key: string): boolean {
  const entry = state.transactions.find((candidate) => candidate.key === key);
  return Boolean(entry && isPendingTransactionStatus(entry.transaction.status));
}

function isReceiptNotFound(error: unknown): boolean {
  const candidate = error as { name?: unknown; shortMessage?: unknown; message?: unknown };
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const message = [candidate?.shortMessage, candidate?.message, error instanceof Error ? error.message : String(error)]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return name === 'TransactionReceiptNotFoundError' || /transaction receipt.*(not found|could not be found)|receipt.*not found/.test(message);
}

function friendlyTransactionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes('user rejected') || lower.includes('user denied') || lower.includes('rejected the request')) return 'Cancelled in your wallet. The plan has not changed.';
  if (lower.includes('invalidamount')) return 'Enter a positive native BOT amount.';
  if (lower.includes('invalidsuccessor') || lower.includes('successorisowner')) return 'The named recipient must be a non-zero address different from the owner and contract.';
  if (lower.includes('samesuccessor')) return 'Choose a different recipient address.';
  if (lower.includes('invalidinactivityperiod')) return 'The check-in interval is outside the allowed bounds.';
  if (lower.includes('invalidgraceperiod')) return 'The extra time is outside the allowed bounds.';
  if (lower.includes('invalidrecipient')) return 'The payout destination cannot be zero or the Lastlight contract.';
  if (lower.includes('vaultnotfound')) return 'Plan not found on this deployment.';
  if (lower.includes('notvaultowner')) return 'Connect the owner wallet named by this plan.';
  if (lower.includes('notvaultsuccessor')) return 'Connect the current recipient wallet named by this plan.';
  if (lower.includes('vultalreadycancelled') || lower.includes('vaultalreadycancelled')) return 'This plan was already closed by its owner.';
  if (lower.includes('vaultalreadyclaimed')) return 'This plan was already claimed and cannot be claimed again.';
  if (lower.includes('ownerwindowclosed')) return 'The final deadline has passed. Owner control has ended.';
  if (lower.includes('vaultnotclaimable')) return 'Claim is not open in the latest chain state.';
  if (lower.includes('invalidpagesize')) return 'The plan list page size is outside the allowed range.';
  if (lower.includes('directpaymentdisabled')) return 'Send native BOT through createVault; direct payments are disabled.';
  if (lower.includes('reentrancyguard')) return 'The contract rejected a reentrant action. No state was changed.';
  if (lower.includes('insufficient funds')) return 'The wallet needs more native BOT for the allocation and gas.';
  if (lower.includes('wallet account changed') || lower.includes('reconnect the named wallet')) return 'The wallet account changed before signing. Reconnect the intended wallet and review the action again.';
  if (lower.includes('native transfer failed')) return 'That payout address could not receive native BOT. Choose another destination.';
  if (lower.includes('included but reverted')) return 'The transaction was included but reverted on-chain. No plan state change was accepted; review the fresh state before retrying.';
  if (lower.includes('wrong chain') || lower.includes('chain')) return 'The wallet or RPC is on the wrong network. Switch and refresh before trying again.';
  if (lower.includes('timeout') || lower.includes('transport')) return 'The chain did not answer in time. Check status before submitting again.';
  return 'The action failed or is still unknown. Check the wallet and receipt before retrying.';
}

function classifyPreBroadcastFailure(error: unknown): Extract<TransactionState['status'], 'rejected' | 'simulation-reverted' | 'wrong-network' | 'rpc-unavailable' | 'failed'> {
  const raw = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (raw.includes('reject') || raw.includes('denied')) return 'rejected';
  if (raw.includes('wrong network') || raw.includes('wrong chain') || raw.includes('expected chain')) return 'wrong-network';
  if (raw.includes('revert') || raw.includes('estimatecontractgas') || raw.includes('simulation')) return 'simulation-reverted';
  if (raw.includes('transport') || raw.includes('fetch failed') || raw.includes('network request') || raw.includes('timed out') || raw.includes('timeout')) return 'rpc-unavailable';
  return 'failed';
}

function transactionEventName(action: string | undefined): string | undefined {
  return action === 'create' ? 'VaultCreated' : action === 'heartbeat' ? 'Heartbeat' : action === 'change-successor' ? 'SuccessorChanged' : action === 'cancel' ? 'VaultCancelled' : action === 'claim' ? 'VaultClaimed' : undefined;
}

function serializedEventArgs(args: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!args) return undefined;
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)]));
}

function sameAddress(value: unknown, expected: string | undefined): boolean {
  return !expected || (typeof value === 'string' && value.toLowerCase() === expected.toLowerCase());
}

function sameBigint(value: unknown, expected: string | undefined): boolean {
  if (!expected) return true;
  try { return BigInt(String(value)) === BigInt(expected); } catch { return false; }
}

function receiptMatchesJournal(transaction: TransactionState, checked: { eventName?: string; vaultId?: bigint; eventArgs?: Record<string, unknown> }): boolean {
  const expectedEvent = transactionEventName(transaction.action);
  if (expectedEvent && checked.eventName !== expectedEvent) return false;
  if (transaction.vaultId && checked.vaultId !== BigInt(transaction.vaultId)) return false;
  const args = checked.eventArgs ?? {};
  if (transaction.action === 'create') {
    return sameAddress(args.owner, transaction.account)
      && sameAddress(args.successor, transaction.expectedRecipient)
      && sameBigint(args.amount, transaction.expectedAmountWei)
      && sameBigint(args.inactivityPeriod, transaction.inactivityPeriod)
      && sameBigint(args.gracePeriod, transaction.gracePeriod);
  }
  if (transaction.action === 'heartbeat') return sameAddress(args.owner, transaction.account);
  if (transaction.action === 'change-successor') return sameAddress(args.newSuccessor, transaction.expectedRecipient);
  if (transaction.action === 'cancel') return sameAddress(args.owner, transaction.account)
    && sameAddress(args.recipient, transaction.expectedRecipient)
    && sameBigint(args.amount, transaction.expectedAmountWei);
  if (transaction.action === 'claim') return sameAddress(args.successor, transaction.account)
    && sameAddress(args.recipient, transaction.expectedRecipient)
    && sameBigint(args.amount, transaction.expectedAmountWei);
  return true;
}

function currentDisplayPlan(): Plan | undefined {
  return activePlanFor(parseRoute());
}

function planRouteUrl(plan: Pick<Plan, 'chainId' | 'contract' | 'vaultId'>, view: 'plan' | 'receive' | 'proof' = 'plan'): string {
  return `${window.location.origin}${window.location.pathname}#/${view}/${plan.chainId}/${plan.contract}/${plan.vaultId.toString()}`;
}

function copyDetailsAction(value: string): { label: string; onClick: () => Promise<void> } {
  return {
    label: 'Copy details',
    onClick: async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(value);
        showTray('Details copied', 'Keep the reminder time and open the plan link to read current chain state.', 'success');
      } catch {
        showTray('Copy unavailable', 'Select the visible plan link and reminder time manually.', 'warning');
      }
    },
  };
}

function ownerReminderDetails(plan: Plan, reminderAt: number): string {
  return `Lastlight owner reminder\nPlan: ${planRouteUrl(plan)}\nReminder time: ${formatDate(reminderAt, true, true)}\nRead the current chain state before acting.`;
}

function recipientReminderDetails(plan: Plan): string {
  return `Lastlight recipient reminder\nPlan: ${planRouteUrl(plan, 'receive')}\nClaim date snapshot: ${formatDate(plan.claimableAt, true, true)}\nRead the current chain state before acting.`;
}

function reminderClockNow(plan: Plan): number | null {
  if (plan.source === 'chain') {
    if (!isObservationFresh(plan.observation)) return null;
    return Number(displayObservedTimestamp(plan.observation, plan.lastHeartbeat));
  }
  return Math.floor(Date.now() / 1000);
}

function localDatetimeValue(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function openReminderPicker(plan: Plan, trigger: HTMLElement, now: number): void {
  const deadline = Number(plan.claimableAt);
  const latestChoice = deadline - 1;
  if (!Number.isFinite(deadline) || latestChoice <= now) {
    showTray('Reminder time has passed', 'There is no future reminder slot before D. Check in now or read the current chain state.', 'warning');
    return;
  }
  const suggested = Math.min(now + 60 * 60, latestChoice);
  const id = 'reminder-picker';
  document.getElementById(id)?.remove();
  document.body.insertAdjacentHTML('beforeend', `<dialog class="action-dialog" id="${id}" aria-labelledby="${id}-title" aria-describedby="${id}-description"><form method="dialog" novalidate><button class="dialog-close icon-button" value="cancel" aria-label="Close dialog">×</button><p class="eyebrow">Choose a local reminder</p><h2 id="${id}-title">The default reminder has passed.</h2><p id="${id}-description" class="dialog-description">Choose a future time before the final deadline, or close this dialog and check in now. The calendar file is a local reminder and does not change the plan.</p><div class="dialog-fields"><div class="field"><label class="field__label" for="reminder-datetime">Reminder time</label><input id="reminder-datetime" type="datetime-local" min="${localDatetimeValue(now + 1)}" max="${localDatetimeValue(latestChoice)}" value="${localDatetimeValue(suggested)}" required aria-describedby="reminder-datetime-hint"><small id="reminder-datetime-hint" class="field__help">Select a time after now and before D · ${escapeHtml(formatDate(plan.claimableAt, true, true))}</small><small id="reminder-picker-error" class="field__error" role="alert" hidden></small></div></div><div class="dialog-actions"><button class="button button--quiet" value="cancel">Cancel</button><button class="button button--primary" type="submit">${icon('download')}<span>Download reminder</span></button></div></form></dialog>`);
  const dialog = document.getElementById(id);
  if (!(dialog instanceof HTMLDialogElement)) return;
  const form = dialog.querySelector('form');
  const input = dialog.querySelector<HTMLInputElement>('#reminder-datetime');
  const error = dialog.querySelector<HTMLElement>('#reminder-picker-error');
  const revision = Number(plan.lastHeartbeatBlock ?? 0n);
  dialog.addEventListener('close', () => { dialog.remove(); trigger.focus(); }, { once: true });
  form?.addEventListener('submit', (event) => {
    if (event.submitter instanceof HTMLButtonElement && event.submitter.value === 'cancel') return;
    event.preventDefault();
    const selected = input?.value ? Math.floor(new Date(input.value).getTime() / 1000) : NaN;
    if (!Number.isFinite(selected) || selected <= now || selected >= deadline) {
      if (error) { error.textContent = 'Choose a future local time before the final deadline.'; error.hidden = false; }
      input?.focus();
      return;
    }
    const downloaded = downloadText(`lastlight-reminder-${plan.chainId}-${plan.vaultId.toString()}.ics`, buildReminderIcs(plan, revision, selected), 'text/calendar;charset=utf-8');
    dialog.close();
    if (!downloaded) {
      showTray('Download unavailable', 'Copy the reminder time and plan link instead. The chain state remains unchanged.', 'warning', copyDetailsAction(ownerReminderDetails(plan, selected)));
      return;
    }
    showTray('Calendar file ready', 'This is one local reminder at the time you chose. It does not sync when the owner checks in.', 'success');
  });
  dialog.showModal();
  input?.focus();
}

async function reconcileTransactions(): Promise<void> {
  const journal = [...state.transactions];
  let changed = false;
  try {
    const { getPublicClient } = await import('./chain/client');
    for (const entry of journal) {
      const transaction = entry.transaction;
      const previouslyConfirmed = transaction.status === 'confirmed';
      if (!isPendingTransactionStatus(transaction.status) && !previouslyConfirmed) continue;
      if (!transaction.hash) {
        if (['validating', 'simulating', 'review-ready', 'awaiting-wallet'].includes(transaction.status)) {
          recordTransaction(entry.key, { ...transaction, status: 'broadcast-unknown', message: 'No transaction hash was recorded before this page was reloaded. Check the wallet before retrying.', updatedAt: new Date().toISOString() });
          changed = true;
        }
        continue;
      }
      if (!transaction.chainId || !isSupportedChain(transaction.chainId)) continue;
      try {
        const client = getPublicClient(transaction.chainId);
        const receipt = await client.getTransactionReceipt({ hash: transaction.hash });
        if (previouslyConfirmed && transaction.blockHash && receipt.blockHash.toLowerCase() !== transaction.blockHash.toLowerCase()) {
          recordTransaction(entry.key, { ...transaction, status: 'reorged', message: 'The recorded block hash changed. The action is being checked against the canonical receipt before it is treated as confirmed again.', updatedAt: new Date().toISOString() });
        } else if (transaction.contract && receipt.to?.toLowerCase() !== transaction.contract.toLowerCase()) {
          recordTransaction(entry.key, { ...transaction, status: 'failed', message: 'Receipt target did not match the saved deployment.', updatedAt: new Date().toISOString() });
        } else if (receipt.status !== 'success') {
          recordTransaction(entry.key, { ...transaction, status: 'onchain-reverted', message: 'The transaction was included but reverted on-chain.', updatedAt: new Date().toISOString() });
        } else {
          const { verifyReceipt } = await import('./chain/receipts');
          const checked = await verifyReceipt(
            transaction.chainId,
            transaction.hash,
            transaction.account,
            transactionEventName(transaction.action),
            transaction.vaultId ? BigInt(transaction.vaultId) : undefined,
            transaction.expectedAmountWei ? BigInt(transaction.expectedAmountWei) : undefined,
            transaction.action === 'cancel' || transaction.action === 'claim' ? transaction.expectedRecipient : undefined,
          );
          if (!hasRequiredConfirmations(checked.confirmations)) {
            recordTransaction(entry.key, { ...transaction, status: 'confirming', message: `Included at block ${receipt.blockNumber.toString()}; waiting for ${2} confirmations before treating it as confirmed.`, updatedAt: new Date().toISOString() });
          } else if (!checked.targetMatches || !checked.senderMatches || !receiptMatchesJournal(transaction, checked)) {
            recordTransaction(entry.key, { ...transaction, status: 'failed', message: 'Receipt identity or event did not match the saved action.', updatedAt: new Date().toISOString() });
          } else {
            recordTransaction(entry.key, {
              ...transaction,
              status: 'confirmed',
              vaultId: transaction.vaultId ?? checked.vaultId?.toString(),
              nonce: checked.nonce?.toString(),
              blockNumber: checked.blockNumber.toString(),
              blockHash: checked.blockHash,
              blockTimestamp: checked.blockTimestamp?.toString(),
              confirmations: checked.confirmations?.toString(),
              receiptStatus: checked.status,
              eventName: checked.eventName,
              eventArgs: serializedEventArgs(checked.eventArgs),
              gasUsed: checked.gasUsed?.toString(),
              effectiveGasPrice: checked.effectiveGasPrice?.toString(),
              feeWei: checked.feeWei?.toString(),
              message: `Included at block ${receipt.blockNumber.toString()}.`,
              updatedAt: new Date().toISOString(),
            });
          }
        }
        changed = true;
      } catch (error) {
        if (previouslyConfirmed && isReceiptNotFound(error)) {
          recordTransaction(entry.key, { ...transaction, status: 'reorged', message: 'The previously confirmed receipt is no longer in the canonical chain. Check status before treating the action as settled.', updatedAt: new Date().toISOString() });
          changed = true;
        }
        /* A pending or unavailable receipt remains pending. */
      }
    }
  } catch { /* The chain client is lazy and optional until a wallet action is requested. */ }
  if (changed) render();
}

function openPlanAction(action: 'heartbeat' | 'change-successor' | 'cancel' | 'claim', initialPlan: Plan): Promise<boolean> {
  if (activePlanAction || walletWriteBusy) {
    showTray('Action already in progress', 'Finish or check the current wallet prompt before starting another plan action.', 'warning');
    return Promise.resolve(false);
  }
  walletWriteBusy = true;
  const pending = performPlanAction(action, initialPlan);
  activePlanAction = pending;
  void pending.then((dialogOpen) => {
    if (activePlanAction === pending) activePlanAction = undefined;
    if (!dialogOpen) walletWriteBusy = false;
  }, () => {
    if (activePlanAction === pending) activePlanAction = undefined;
    walletWriteBusy = false;
  });
  return pending;
}

async function performPlanAction(action: 'heartbeat' | 'change-successor' | 'cancel' | 'claim', initialPlan: Plan): Promise<boolean> {
  if (!state.wallet.account) {
    showTray('Connect a wallet first', 'The selected role and payout destination are checked again before signing.', 'warning');
    return false;
  }
  const account = state.wallet.account;
  if (state.wallet.chainId !== initialPlan.chainId) {
    showTray('Switch network to continue', `This plan is on ${chains[initialPlan.chainId].name}. The wallet is currently on ${state.wallet.chainId ? chains[state.wallet.chainId as keyof typeof chains]?.name ?? `chain ${state.wallet.chainId}` : 'an unknown network'}.`, 'warning', {
      label: `Switch to ${chains[initialPlan.chainId].shortName}`,
      onClick: async () => {
        const { switchToChain } = await import('./chain/wallet');
        const switched = await switchToChain(initialPlan.chainId);
        if (!switched.ok) showTray('Network switch declined', switched.error ?? 'Switch networks in the wallet, then retry.', 'warning');
        else { state.wallet = { ...state.wallet, chainId: initialPlan.chainId }; render(); }
      },
    });
    return false;
  }
  showTray('Refreshing plan', 'Reading the latest observation block before preparing this action.', 'info');
  let plan = initialPlan;
  try {
    const { readPlan } = await import('./chain/read');
    const fresh = await readPlan(initialPlan.chainId, initialPlan.vaultId);
    if (!fresh) throw new Error('This deployment did not return the plan.');
    plan = fresh;
    state.activePlan = fresh;
    state.activePlanError = undefined;
    state.activePlanDiagnostic = undefined;
  } catch (error) {
    showTray('Plan is not fresh', friendlyTransactionError(error), 'warning', undefined, error);
    return false;
  }
  const ownerAction = action === 'heartbeat' || action === 'change-successor' || action === 'cancel';
  if (ownerAction && plan.owner.toLowerCase() !== account.toLowerCase()) {
    showTray('Owner wallet required', 'The connected wallet is not the owner named by this plan.', 'warning');
    return false;
  }
  if (action === 'claim' && plan.successor.toLowerCase() !== account.toLowerCase()) {
    showTray('Recipient wallet required', 'Connect the current named recipient wallet to claim this plan.', 'warning');
    return false;
  }
  if (ownerAction && plan.status !== 'ACTIVE' && plan.status !== 'GRACE') {
    showTray('Owner control has ended', 'This action is unavailable after the final deadline or settlement.', 'warning');
    render();
    return false;
  }
  if (action === 'claim' && plan.status !== 'CLAIMABLE') {
    showTray('Claim is not open', 'The latest chain state does not allow the recipient to claim yet.', 'warning');
    render();
    return false;
  }
  const id = `action-${action}-${plan.chainId}-${plan.vaultId.toString()}`;
  const defaultPayout = action === 'cancel' ? plan.owner : plan.successor;
  const secondsUntilDeadline = plan.status === 'GRACE' && isObservationFresh(plan.observation)
    ? Number(plan.claimableAt - displayObservedTimestamp(plan.observation, plan.lastHeartbeat))
    : Number.POSITIVE_INFINITY;
  const deadlineWarning = action === 'heartbeat' && secondsUntilDeadline <= 60
    ? 'Confirmation may arrive too late. A signature is not inclusion; leave time for the transaction to be mined before D.'
    : undefined;
  let initialFeeText = action === 'change-successor' ? 'Calculated after the new recipient is entered' : 'Unavailable until the current review is simulated';
  if (action === 'heartbeat' || action === 'cancel' || action === 'claim') {
    try {
      const { estimateVaultAction } = await import('./chain/write');
      const { getInjectedProvider } = await import('./chain/wallet');
      const feeEstimate = await estimateVaultAction(
        plan.chainId,
        account,
        action === 'heartbeat'
          ? { kind: 'heartbeat', vaultId: plan.vaultId }
            : action === 'cancel'
              ? { kind: 'cancel', vaultId: plan.vaultId, recipient: defaultPayout }
            : { kind: 'claim', vaultId: plan.vaultId, recipient: defaultPayout },
        getInjectedProvider(),
        planActionIntentKey(plan, account, action, action === 'heartbeat' ? undefined : defaultPayout),
      );
      initialFeeText = `${formatNativeAmount(BigInt(feeEstimate.feeWei))} · ${feeEstimate.gasLimit} gas`;
    } catch {
      initialFeeText = 'Unavailable · checked again before signing';
    }
  }
  const dialog = renderActionDialog({
    id,
    title: action === 'heartbeat' ? 'Check in for this plan' : action === 'change-successor' ? 'Change the named recipient' : action === 'cancel' ? 'Close the plan' : 'Claim the allocation',
    description: action === 'heartbeat' ? 'A confirmed heartbeat updates H for this plan. The action does not change the amount or policy.' : action === 'change-successor' ? 'The final deadline stays the same. The old recipient loses claim authority once this transaction is confirmed.' : action === 'cancel' ? 'Closing returns the full outstanding allocation and permanently settles this plan.' : 'The deadline has passed. Review the full payout destination and submit one manual claim.',
    actionLabel: action === 'heartbeat' ? 'Confirm check-in' : action === 'change-successor' ? 'Change recipient' : action === 'cancel' ? 'Close & return BOT' : 'Claim BOT',
    rows: action === 'heartbeat'
      ? [['Current check-in by', formatDate(plan.checkInBy, true, true)], ['Final deadline', formatDate(plan.claimableAt, true, true)], ['New R after inclusion', formatDate(Number(plan.observation?.blockTimestamp ?? plan.lastHeartbeat) + Number(plan.inactivityPeriod), true, true)], ['New D after inclusion', formatDate(Number(plan.observation?.blockTimestamp ?? plan.lastHeartbeat) + Number(plan.inactivityPeriod) + Number(plan.gracePeriod), true, true)], ['Policy', `${formatDuration(Number(plan.inactivityPeriod))} + ${formatDuration(Number(plan.gracePeriod))}`], ['Network', chains[plan.chainId].name]]
      : action === 'change-successor'
        ? [['Current recipient', plan.successor], ['New recipient', 'Entered below'], ['Final deadline · unchanged', formatDate(plan.claimableAt, true, true)], ['Allocation', formatNativeAmount(plan.depositedAmount)], ['Network', chains[plan.chainId].name]]
        : [['Outstanding amount', formatNativeAmount(plan.amount)], ...(action === 'claim' ? [['Authorized wallet', account] as [string, string]] : []), ['Payout destination', defaultPayout], ['Network', chains[plan.chainId].name]],
    fields: action === 'change-successor'
      ? [{ id: 'action-new-successor', label: 'New recipient address', hint: 'The contract accepts an address; it does not verify identity.', required: true }]
      : action === 'cancel' || action === 'claim'
        ? [{ id: 'action-payout-recipient', label: 'Payout destination', value: defaultPayout, hint: 'This destination receives the full amount. It does not receive authority.', required: true }]
        : undefined,
    fee: initialFeeText,
    warning: deadlineWarning ?? (action === 'cancel' ? 'This cannot be reopened. A receiving contract must accept native BOT.' : action === 'claim' ? 'The funds have not moved until this transaction is confirmed.' : action === 'change-successor' ? 'A previously downloaded kit is only a snapshot. The current plan and recipient are read again when the link opens.' : undefined),
  });
  document.body.insertAdjacentHTML('beforeend', dialog);
  const dialogElement = document.getElementById(id);
  if (!(dialogElement instanceof HTMLDialogElement)) return false;
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let transactionInFlight = false;
  dialogElement.addEventListener('close', () => { walletWriteBusy = false; dialogElement.remove(); trigger?.focus(); }, { once: true });
  dialogElement.addEventListener('cancel', (event) => {
    if (transactionInFlight) event.preventDefault();
  });
  dialogElement.showModal();
  const confirmButton = dialogElement.querySelector<HTMLButtonElement>('[data-dialog-confirm]');
  confirmButton?.addEventListener('click', async (event) => {
    event.preventDefault();
    const field = (fieldId: string) => dialogElement.querySelector<HTMLInputElement>(`#${fieldId}`)?.value.trim() ?? '';
    const newSuccessor = action === 'change-successor' ? normalizeAddress(field('action-new-successor')) : null;
    const payout = action === 'cancel' || action === 'claim' ? normalizeAddress(field('action-payout-recipient')) : null;
    if (action === 'change-successor' && (!newSuccessor || newSuccessor.toLowerCase() === plan.owner.toLowerCase() || newSuccessor.toLowerCase() === plan.successor.toLowerCase() || newSuccessor.toLowerCase() === plan.contract.toLowerCase() || isZeroAddress(field('action-new-successor')) || hasBadMixedChecksum(field('action-new-successor')))) {
      showTray('Recipient address needs attention', 'Use a valid non-zero address different from the owner and current recipient.', 'warning');
      return;
    }
    if ((action === 'cancel' || action === 'claim') && (!payout || payout.toLowerCase() === plan.contract.toLowerCase() || payout === '0x0000000000000000000000000000000000000000' || hasBadMixedChecksum(field('action-payout-recipient')))) {
      showTray('Payout destination needs attention', 'Use a valid address other than zero or the Lastlight contract.', 'warning');
      return;
    }
    confirmButton.disabled = true;
    showTray('Preparing transaction', 'The exact method, caller, value, network, and current chain state are being simulated.', 'info');
    const intentTarget = action === 'change-successor' ? newSuccessor! : action === 'cancel' || action === 'claim' ? payout! : undefined;
    const txKey = planActionIntentKey(plan, account, action, intentTarget);
    const method = action === 'heartbeat' ? 'heartbeat' : action === 'change-successor' ? 'changeSuccessor' : action === 'cancel' ? 'cancelVault' : 'claim';
    const journalArgs = action === 'heartbeat'
      ? [plan.vaultId.toString()]
      : action === 'change-successor'
        ? [plan.vaultId.toString(), newSuccessor!]
        : [plan.vaultId.toString(), payout!];
    const expectedRecipient = action === 'change-successor' ? newSuccessor! : action === 'cancel' || action === 'claim' ? payout! : undefined;
    const expectedAmountWei = action === 'cancel' || action === 'claim' ? plan.amount.toString() : undefined;
    if (transactionNeedsReconciliation(txKey)) {
      confirmButton.disabled = false;
      showTray('Transaction still needs checking', 'This exact action already has a pending or unknown journal entry. Check its receipt before submitting again.', 'warning');
      return;
    }
    transactionInFlight = true;
    let submittedHash: `0x${string}` | undefined;
    let replacementReason: 'cancelled' | 'replaced' | 'repriced' | undefined;
    recordTransaction(txKey, {
      status: 'validating', action, account, chainId: plan.chainId, contract: plan.contract,
      vaultId: plan.vaultId.toString(), method, args: journalArgs, valueWei: '0', expectedRecipient,
      expectedAmountWei, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    try {
      const actionArgs = action === 'heartbeat'
        ? { kind: 'heartbeat' as const, vaultId: plan.vaultId }
        : action === 'change-successor'
          ? { kind: 'change-successor' as const, vaultId: plan.vaultId, newSuccessor: newSuccessor! }
          : action === 'cancel'
          ? { kind: 'cancel' as const, vaultId: plan.vaultId, recipient: payout! }
            : { kind: 'claim' as const, vaultId: plan.vaultId, recipient: payout! };
      recordTransaction(txKey, { status: 'simulating', action, updatedAt: new Date().toISOString() });
      const { estimateVaultAction } = await import('./chain/write');
      const { getInjectedProvider } = await import('./chain/wallet');
      const feeEstimate = await estimateVaultAction(plan.chainId, account, actionArgs, getInjectedProvider(), txKey);
      const feeNode = dialogElement.querySelector<HTMLElement>('[data-dialog-fee] dd');
      if (feeNode) feeNode.textContent = `${formatNativeAmount(BigInt(feeEstimate.feeWei))} · ${feeEstimate.gasLimit} gas`;
      showTray('Fee checked', `Estimated ${formatNativeAmount(BigInt(feeEstimate.feeWei))} for gas, separate from the plan allocation.`, 'info');
      recordTransaction(txKey, { status: 'awaiting-wallet', action, updatedAt: new Date().toISOString() });
      const { executeVaultAction } = await import('./chain/write');
      const result = await executeVaultAction(plan.chainId, account, actionArgs, getInjectedProvider(), {
        onSubmitted: (hash) => {
          submittedHash = hash;
          recordTransaction(txKey, { status: 'confirming', action, hash, updatedAt: new Date().toISOString() });
          showTray('Transaction submitted', 'The hash is saved locally while the chain confirms it. Do not submit the same action again.', 'info');
        },
        onReplaced: (hash, reason) => {
          replacementReason = reason;
          submittedHash = hash;
          recordTransaction(txKey, { status: reason === 'cancelled' ? 'cancelled-replacement' : reason === 'repriced' ? 'repriced' : 'replaced', action, hash, updatedAt: new Date().toISOString(), message: reason === 'cancelled' ? 'The wallet cancelled the pending replacement.' : `The wallet ${reason} the pending transaction; checking the replacement receipt.` });
          showTray(reason === 'cancelled' ? 'Replacement cancelled' : reason === 'repriced' ? 'Transaction repriced' : 'Transaction replaced', reason === 'cancelled' ? 'The business action was not confirmed. Check status before trying again.' : 'The replacement hash is being checked against the same action.', 'warning');
        },
      });
      const { verifyReceipt } = await import('./chain/receipts');
      const eventName = action === 'heartbeat' ? 'Heartbeat' : action === 'change-successor' ? 'SuccessorChanged' : action === 'cancel' ? 'VaultCancelled' : 'VaultClaimed';
      const expectedAmount = action === 'cancel' || action === 'claim' ? plan.amount : undefined;
      const expectedRecipient = action === 'cancel' || action === 'claim' ? payout! : undefined;
      const verified = await verifyReceipt(plan.chainId, result.hash, account, eventName, plan.vaultId, expectedAmount, expectedRecipient);
      const eventArgs = verified.eventArgs ?? {};
      const actionEventMatches = action === 'heartbeat'
          ? sameAddress(eventArgs.owner, account)
          : action === 'change-successor'
          ? sameAddress(eventArgs.previousSuccessor, plan.successor) && sameAddress(eventArgs.newSuccessor, newSuccessor!)
          : action === 'cancel'
            ? sameAddress(eventArgs.owner, account) && sameAddress(eventArgs.recipient, payout!) && sameBigint(eventArgs.amount, plan.amount.toString())
            : sameAddress(eventArgs.successor, account) && sameAddress(eventArgs.recipient, payout!) && sameBigint(eventArgs.amount, plan.amount.toString());
      if (!verified.targetMatches || !verified.senderMatches || verified.eventName !== eventName || !actionEventMatches) throw new Error('Receipt did not match the configured contract, caller, action arguments, or expected event.');
      const { readPlan } = await import('./chain/read');
      let refreshed = true;
      try {
        const refreshedPlan = await readPlan(plan.chainId, plan.vaultId);
        state.activePlan = refreshedPlan ? { ...refreshedPlan, transactionHash: result.hash, transactionBlockNumber: result.receipt.blockNumber } : state.activePlan;
      } catch {
        refreshed = false;
      }
      recordTransaction(txKey, {
        status: 'confirmed', action, hash: result.hash, updatedAt: new Date().toISOString(),
        blockNumber: result.receipt.blockNumber.toString(), blockHash: result.receipt.blockHash,
        receiptStatus: 'success', eventName, eventArgs: serializedEventArgs(verified.eventArgs),
        confirmations: verified.confirmations?.toString(), nonce: verified.nonce?.toString(),
        blockTimestamp: verified.blockTimestamp?.toString(), gasUsed: verified.gasUsed?.toString(), effectiveGasPrice: verified.effectiveGasPrice?.toString(), feeWei: verified.feeWei?.toString(),
        message: `Included at block ${result.receipt.blockNumber.toString()}.`,
      });
      const evidence = {
        action,
        hash: result.hash,
        nonce: verified.nonce?.toString(),
        blockNumber: verified.blockNumber.toString(),
        blockHash: verified.blockHash,
        blockTimestamp: verified.blockTimestamp?.toString(),
        confirmations: verified.confirmations?.toString(),
        receiptStatus: verified.status,
        eventName: verified.eventName,
        eventArgs: serializedEventArgs(verified.eventArgs),
        gasUsed: verified.gasUsed?.toString(),
        effectiveGasPrice: verified.effectiveGasPrice?.toString(),
        feeWei: verified.feeWei?.toString(),
      } as const;
      if (state.activePlan && state.activePlan.vaultId === plan.vaultId) {
        state.activePlan = { ...state.activePlan, transactionHash: result.hash, transactionBlockNumber: result.receipt.blockNumber, transactions: [evidence, ...(state.activePlan.transactions ?? []).filter((entry) => entry.hash !== result.hash)] };
      }
      transactionInFlight = false;
      dialogElement.close();
      render();
      showTray('Transaction confirmed', refreshed ? `${eventName} was included at block ${result.receipt.blockNumber.toString()} and the plan was refreshed.` : `${eventName} was included at block ${result.receipt.blockNumber.toString()}. Details are refreshing; retry the read when the RPC responds.`, 'success');
    } catch (error) {
      transactionInFlight = false;
      confirmButton.disabled = false;
      const raw = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const status = replacementReason === 'cancelled' ? 'cancelled-replacement' : submittedHash ? (raw.includes('timeout') ? 'pending-timeout' : raw.includes('included but reverted') ? 'onchain-reverted' : 'unknown') : classifyPreBroadcastFailure(error);
      recordTransaction(txKey, { status, action, hash: submittedHash, updatedAt: new Date().toISOString(), message: friendlyTransactionError(error) });
      showTray('Transaction not confirmed', friendlyTransactionError(error), 'warning', undefined, error);
    }
  });
  return true;
}

function bindPageEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('.js-shell-connect').forEach((element) => element.addEventListener('click', () => {
    document.querySelector<HTMLButtonElement>('#connect-wallet')?.click();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-plan-action]').forEach((element) => element.addEventListener('click', () => {
    const action = element.dataset.planAction;
    const route = parseRoute();
    const plan = activePlanFor(route);
    if ((action === 'heartbeat' || action === 'change-successor' || action === 'cancel' || action === 'claim') && plan) void openPlanAction(action, plan);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-plan-role]').forEach((element) => element.addEventListener('click', () => {
    const role = element.dataset.planRole;
    if (role === 'owner' || role === 'successor') {
      invalidateListHydration();
      state.planRole = role;
      state.livePlans = [];
      state.plansLoadedIds = [];
      state.plansNextOffset = 0n;
      state.plansQuery = '';
      state.plansTotal = 0n;
      state.plansObservedBlock = undefined;
      state.planRowErrors = {};
      state.planRowDiagnostics = {};
      state.plansDiagnostic = undefined;
      loadedListKey = null;
      render();
    }
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-load-more]').forEach((element) => element.addEventListener('click', () => { void loadMorePlans(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-retry-plans]').forEach((element) => element.addEventListener('click', () => {
    invalidateListHydration();
    loadedListKey = null;
    state.plansError = undefined;
    state.plansDiagnostic = undefined;
    state.planRowErrors = {};
    state.planRowDiagnostics = {};
    state.plansLoading = true;
    render();
    void hydrateLivePlans(true);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-retry-plan]').forEach((element) => element.addEventListener('click', () => {
    try { void retryPlanRow(BigInt(element.dataset.retryPlan ?? '0')); } catch { /* the route never renders a non-numeric row ID */ }
  }));
  document.querySelectorAll<HTMLFormElement>('[data-plans-search-form]').forEach((form) => form.addEventListener('submit', (event) => {
    event.preventDefault();
    state.plansQuery = String(new FormData(form).get('q') ?? '').slice(0, 80);
    render();
    document.querySelector<HTMLInputElement>('#plans-search')?.focus();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-retry-live]').forEach((element) => element.addEventListener('click', () => {
    state.activePlan = undefined;
    state.activePlanError = undefined;
    state.activePlanDiagnostic = undefined;
    state.plansTotal = 0n;
    state.plansLoadedIds = [];
    state.plansNextOffset = 0n;
    state.plansObservedBlock = undefined;
    state.planRowErrors = {};
    state.planRowDiagnostics = {};
    state.plansDiagnostic = undefined;
    invalidateLivePlanHydration();
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-retry-proof]').forEach((element) => element.addEventListener('click', () => {
    proofPageLoadError = false;
    proofPageLoad = undefined;
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-refresh-live]').forEach((element) => element.addEventListener('click', () => {
    state.activePlan = undefined;
    state.activePlanError = undefined;
    state.activePlanDiagnostic = undefined;
    invalidateLivePlanHydration();
    render();
  }));
  document.querySelectorAll<HTMLFormElement>('[data-locator-route]').forEach((form) => form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const chain = Number(data.get('chain'));
    const contract = String(data.get('contract') ?? '').trim();
    const id = String(data.get('id') ?? '').trim();
    if (!Number.isInteger(chain) || !contract || !/^[1-9]\d*$/.test(id)) return;
    navigate(`/${form.dataset.locatorRoute ?? 'plan'}/${chain}/${contract}/${id}`);
  }));
  document.querySelectorAll<HTMLElement>('[role="tab"]').forEach((tab) => tab.addEventListener('keydown', (event) => {
    const key = event.key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    const tabs = Array.from(tab.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const index = tabs.indexOf(tab);
    if (index < 0 || tabs.length < 2) return;
    event.preventDefault();
    const nextIndex = key === 'Home' ? 0 : key === 'End' ? tabs.length - 1 : (index + (key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    const role = next.dataset.planRole;
    if (role === 'owner' || role === 'successor') {
      invalidateListHydration();
      state.planRole = role;
      state.livePlans = [];
      state.plansLoadedIds = [];
      state.plansNextOffset = 0n;
      state.plansQuery = '';
      state.plansTotal = 0n;
      state.plansObservedBlock = undefined;
      state.planRowErrors = {};
      state.planRowDiagnostics = {};
      state.plansDiagnostic = undefined;
      loadedListKey = null;
    }
    render();
    window.setTimeout(() => document.getElementById(next.id)?.focus(), 0);
  }));

  document.querySelectorAll<HTMLButtonElement>('[data-create-step]').forEach((element) => element.addEventListener('click', () => {
    const requested = Number(element.dataset.createStep) as 0 | 1 | 2 | 3;
    if (requested <= state.draft.step || validationForStep(state.draft.step)) {
      state.createValidationAttemptedStep = undefined;
      updateDraft((draft) => { draft.step = requested; });
    } else {
      state.createValidationAttemptedStep = state.draft.step;
      render();
    }
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-create-back]').forEach((element) => element.addEventListener('click', () => {
    if (state.draft.step > 0) updateDraft((draft) => { draft.step = (draft.step - 1) as 0 | 1 | 2 | 3; });
  }));
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-draft-field]').forEach((element) => {
      const update = (event: Event) => {
      const field = element.dataset.draftField;
      if (!field) return;
      if (field === 'inactivityPeriod' || field === 'gracePeriod') {
        const customFlag = field === 'inactivityPeriod' ? 'inactivityCustom' : 'graceCustom';
        const unitField = field === 'inactivityPeriod' ? 'inactivityUnit' : 'graceUnit';
        if (element.value === 'custom') updateDraft((draft) => { draft[customFlag] = true; draft[unitField] ??= 'days'; }, false);
        else if (/^\d+$/.test(element.value)) updateDraft((draft) => { draft[field] = Number(element.value); draft[customFlag] = false; delete draft[unitField]; }, false);
      } else if (field === 'recipient' || field === 'label' || field === 'amount') updateDraft((draft) => { draft[field] = element.value; }, false);
      state.draft.acknowledgements = [false, false];
      state.draft.shortTimingAcknowledgement = false;
      if (state.draft.step === 3) state.draft.step = 0;
      persistDraft();
      if (event.type === 'change' && (field === 'inactivityPeriod' || field === 'gracePeriod')) render();
    };
    element.addEventListener('input', update);
    element.addEventListener('change', update);
  });
  document.querySelectorAll<HTMLInputElement>('[data-custom-period]').forEach((element) => {
    const updateCustomPeriod = (event?: Event) => {
      const field = element.dataset.customPeriod as 'inactivityPeriod' | 'gracePeriod' | undefined;
      if (!field) return;
      const unit = (document.querySelector<HTMLSelectElement>(`[data-custom-unit="${field}"]`)?.value ?? 'days') as DurationUnit;
      const multiplier = unit === 'seconds' ? 1 : unit === 'minutes' ? 60 : unit === 'hours' ? 3600 : 86400;
      const value = Number(element.value);
      const unitField = field === 'inactivityPeriod' ? 'inactivityUnit' : 'graceUnit';
      if (Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(value * multiplier)) updateDraft((draft) => { draft[field] = value * multiplier; draft[unitField] = unit; }, false);
      state.draft.acknowledgements = [false, false];
      state.draft.shortTimingAcknowledgement = false;
      if (state.draft.step === 3) state.draft.step = 0;
      persistDraft();
      if (event?.type === 'change') window.setTimeout(() => { if (parseRoute().name === 'create') render(); }, 0);
    };
    element.addEventListener('input', updateCustomPeriod);
    element.addEventListener('change', updateCustomPeriod);
  });
  document.querySelectorAll<HTMLSelectElement>('[data-custom-unit]').forEach((element) => element.addEventListener('change', () => {
    const field = element.dataset.customUnit as 'inactivityPeriod' | 'gracePeriod' | undefined;
    const input = field ? document.querySelector<HTMLInputElement>(`[data-custom-period="${field}"]`) : null;
    const unitField = field === 'inactivityPeriod' ? 'inactivityUnit' : field === 'gracePeriod' ? 'graceUnit' : undefined;
    if (unitField && (element.value === 'seconds' || element.value === 'minutes' || element.value === 'hours' || element.value === 'days')) {
      updateDraft((draft) => { draft[unitField] = element.value as DurationUnit; }, false);
    }
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    window.setTimeout(() => { if (parseRoute().name === 'create') render(); }, 0);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-fill-recipient]').forEach((element) => element.addEventListener('click', () => {
    updateDraft((draft) => { draft.recipient = '0x0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; });
  }));
  document.querySelectorAll<HTMLButtonElement>('.js-create-next').forEach((element) => element.addEventListener('click', () => {
    if (validationForStep(state.draft.step)) {
      state.createValidationAttemptedStep = undefined;
      updateDraft((draft) => { draft.step = Math.min(3, draft.step + 1) as 0 | 1 | 2 | 3; });
    }
    else {
      state.createValidationAttemptedStep = state.draft.step;
      render();
      window.setTimeout(() => {
        const firstInvalid = document.querySelector<HTMLElement>('.field--error input, .field--error select, .form-error')
          ?? document.querySelector<HTMLElement>('[data-draft-field]');
        firstInvalid?.focus();
      }, 0);
    }
  }));
  document.querySelectorAll<HTMLInputElement>('[data-ack]').forEach((element) => element.addEventListener('change', () => {
    const index = Number(element.dataset.ack) as 0 | 1;
    state.draft.acknowledgements[index] = element.checked;
    persistDraft();
    render();
  }));
  document.querySelectorAll<HTMLInputElement>('[data-short-timing-ack]').forEach((element) => element.addEventListener('change', () => {
    state.draft.shortTimingAcknowledgement = element.checked;
    persistDraft();
    render();
  }));
  document.querySelector<HTMLInputElement>('[data-draft-persistence]')?.addEventListener('change', (event) => {
    const enabled = (event.target as HTMLInputElement).checked;
    if (!setDraftPersistenceEnabled(enabled)) {
      state.storageAvailable = false;
      state.draftPersistenceEnabled = false;
      render();
      return;
    }
    state.draftPersistenceEnabled = enabled;
    if (enabled && !saveDraft(state.draft, true)) {
      setDraftPersistenceEnabled(false);
      state.storageAvailable = false;
      state.draftPersistenceEnabled = false;
    }
    render();
  });
  document.querySelectorAll<HTMLButtonElement>('.js-create-submit').forEach((element) => element.addEventListener('click', async () => {
    const chainId = (MAINNET_ONLY ? 677 : state.wallet.chainId ?? DEFAULT_CHAIN) as keyof typeof manifests;
    const manifest = manifests[chainId];
    if (!state.wallet.account) {
      showTray('Connect a wallet first', 'The live flow compares the owner, network, balance, and fee before a signature. No transaction was sent.', 'warning');
      return;
    }
    if (!isSupportedChain(chainId as number)) {
      showTray('Unsupported wallet network', MAINNET_ONLY ? 'Switch your wallet to BOT Chain Mainnet before preparing a plan.' : 'Select BOT Testnet or BOT Mainnet before preparing a write.', 'warning');
      return;
    }
    if (state.wallet.chainId !== chainId) {
      showTray('Switch network to continue', `The plan will be created on ${chains[chainId].name}.`, 'warning', {
      label: `Switch to ${chains[chainId].shortName}`,
      onClick: async () => {
        const { switchToChain } = await import('./chain/wallet');
        const switched = await switchToChain(chainId);
          if (!switched.ok) showTray('Network switch declined', switched.error ?? 'Switch networks in the wallet, then retry.', 'warning');
          else { state.wallet = { ...state.wallet, chainId }; render(); }
        },
      });
      return;
    }
    if (!manifest?.contractAddress || manifest.verificationStatus !== 'verified') {
      showTray('Live write is gated', 'No verified BOT contract address is configured. Your draft is safe; no transaction was sent.', 'warning');
      return;
    }
    const recipient = normalizeAddress(state.draft.recipient);
    const amount = parseNativeAmount(state.draft.amount);
    if (!recipient || !amount) {
      showTray('Review is out of date', 'Recipient or amount changed. Return to the relevant step and review it again.', 'warning');
      return;
    }
    const txKey = `create:${chainId}:${manifest.contractAddress.toLowerCase()}:${state.wallet.account.toLowerCase()}:${recipient.toLowerCase()}:${amount.toString()}:${state.draft.inactivityPeriod}:${state.draft.gracePeriod}`;
    if (transactionNeedsReconciliation(txKey)) {
      showTray('Transaction still needs checking', 'This exact create intent already has a pending or unknown journal entry. Check its receipt before submitting again.', 'warning');
      return;
    }
    if (walletWriteBusy) {
      showTray('Action already in progress', 'Finish or check the current wallet prompt before starting another write.', 'warning');
      return;
    }
    walletWriteBusy = true;
    element.disabled = true;
    showTray('Preparing wallet review', 'Refreshing chain time and simulating the exact createVault call.', 'info');
    let submittedHash: `0x${string}` | undefined;
    let replacementReason: 'cancelled' | 'replaced' | 'repriced' | undefined;
    recordTransaction(txKey, {
      status: 'validating', action: 'create', account: state.wallet.account, chainId, contract: manifest.contractAddress,
      method: 'createVault', args: [recipient, state.draft.inactivityPeriod.toString(), state.draft.gracePeriod.toString()],
      valueWei: amount.toString(), expectedRecipient: recipient, expectedAmountWei: amount.toString(),
      inactivityPeriod: state.draft.inactivityPeriod.toString(), gracePeriod: state.draft.gracePeriod.toString(),
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    try {
      recordTransaction(txKey, { status: 'simulating', action: 'create', updatedAt: new Date().toISOString() });
      const { estimateVaultAction } = await import('./chain/write');
      const { getInjectedProvider } = await import('./chain/wallet');
      const createAction = { kind: 'create' as const, successor: recipient, inactivityPeriod: BigInt(state.draft.inactivityPeriod), gracePeriod: BigInt(state.draft.gracePeriod), value: amount };
      const feeEstimate = await estimateVaultAction(chainId, state.wallet.account, createAction, getInjectedProvider(), txKey);
      showTray('Fee checked', `Estimated ${formatNativeAmount(BigInt(feeEstimate.feeWei))} for gas, separate from the plan allocation.`, 'info');
      recordTransaction(txKey, { status: 'awaiting-wallet', action: 'create', updatedAt: new Date().toISOString() });
      const { executeVaultAction } = await import('./chain/write');
      const result = await executeVaultAction(chainId, state.wallet.account, createAction, getInjectedProvider(), {
        onSubmitted: (hash) => {
          submittedHash = hash;
          recordTransaction(txKey, { status: 'confirming', action: 'create', hash, updatedAt: new Date().toISOString() });
          showTray('Transaction submitted', 'The create hash is saved locally while the chain confirms it. Do not fund a second plan until this one is reconciled.', 'info');
        },
        onReplaced: (hash, reason) => {
          replacementReason = reason;
          submittedHash = hash;
          recordTransaction(txKey, { status: reason === 'cancelled' ? 'cancelled-replacement' : reason === 'repriced' ? 'repriced' : 'replaced', action: 'create', hash, updatedAt: new Date().toISOString(), message: reason === 'cancelled' ? 'The wallet cancelled the pending replacement.' : `The wallet ${reason} the pending create; checking the replacement receipt.` });
          showTray(reason === 'cancelled' ? 'Create replacement cancelled' : reason === 'repriced' ? 'Create transaction repriced' : 'Create transaction replaced', reason === 'cancelled' ? 'No plan confirmation was recorded. Check status before trying again.' : 'The replacement hash is being checked against the create event.', 'warning');
        },
      });
      const { verifyReceipt } = await import('./chain/receipts');
      const verified = await verifyReceipt(chainId, result.hash, state.wallet.account, 'VaultCreated', undefined, amount);
      const eventArgs = verified.eventArgs ?? {};
      const eventMatches = eventArgs.owner?.toString().toLowerCase() === state.wallet.account.toLowerCase()
        && eventArgs.successor?.toString().toLowerCase() === recipient.toLowerCase()
        && eventArgs.amount === amount
        && eventArgs.inactivityPeriod === BigInt(state.draft.inactivityPeriod)
        && eventArgs.gracePeriod === BigInt(state.draft.gracePeriod);
      if (!verified.targetMatches || !verified.senderMatches || !verified.vaultId || !eventMatches) throw new Error('Receipt did not match the configured deployment, sender, recipient, periods, or create amount.');
      if (state.draft.label) saveLabel(chainId, manifest.contractAddress!, verified.vaultId.toString(), state.draft.label);
      recordTransaction(txKey, {
        status: 'confirmed', action: 'create', hash: result.hash, vaultId: verified.vaultId.toString(), updatedAt: new Date().toISOString(),
        blockNumber: result.receipt.blockNumber.toString(), blockHash: result.receipt.blockHash,
        receiptStatus: 'success', eventName: 'VaultCreated', eventArgs: serializedEventArgs(verified.eventArgs),
        confirmations: verified.confirmations?.toString(), nonce: verified.nonce?.toString(),
        blockTimestamp: verified.blockTimestamp?.toString(), feeWei: verified.feeWei?.toString(),
        message: `Included at block ${result.receipt.blockNumber.toString()}.`,
      });
      navigate(`/plan/${chainId}/${manifest.contractAddress}/${verified.vaultId.toString()}`);
      window.setTimeout(() => showTray('Plan created and receipt verified', `Plan #${verified.vaultId!.toString()} was included at block ${result.receipt.blockNumber.toString()}. The detail view is reading the fresh chain state.`, 'success'), 0);
    } catch (error) {
      const message = friendlyTransactionError(error);
      const raw = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      const status = replacementReason === 'cancelled' ? 'cancelled-replacement' : submittedHash ? (raw.includes('timeout') ? 'pending-timeout' : raw.includes('included but reverted') ? 'onchain-reverted' : 'unknown') : classifyPreBroadcastFailure(error);
      recordTransaction(txKey, { status, action: 'create', hash: submittedHash, updatedAt: new Date().toISOString(), message });
      showTray('No plan was confirmed', message, 'warning', undefined, error);
    } finally {
      walletWriteBusy = false;
      element.disabled = false;
    }
  }));

  document.querySelectorAll<HTMLButtonElement>('.js-copy').forEach((element) => element.addEventListener('click', async () => {
    const value = element.dataset.copy ?? '';
    let copied = false;
    try { await navigator.clipboard.writeText(value); copied = true; } catch { /* fall through to selectable text */ }
    const original = element.innerHTML;
    element.innerHTML = copied ? `${icon('check')}<span>${element.classList.contains('icon-button') ? '<span class="sr-only">Copied</span>' : 'Copied'}</span>` : `${icon('copy')}<span>${element.classList.contains('icon-button') ? '<span class="sr-only">Copy unavailable; select text</span>' : 'Copy unavailable'}</span>`;
    window.setTimeout(() => { element.innerHTML = original; }, 1800);
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-clear-local-data]').forEach((element) => element.addEventListener('click', () => {
    clearLocalData();
    state.draft = { ...defaultDraft, acknowledgements: [...defaultDraft.acknowledgements] as [boolean, boolean] };
    state.draftPersistenceEnabled = false;
    state.transactions = [];
    render();
    showTray('Local data cleared', 'This removed browser convenience data. Plans on-chain were not changed.', 'success');
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-reconcile-transactions]').forEach((element) => element.addEventListener('click', () => { void reconcileTransactions(); }));
  document.querySelectorAll<HTMLButtonElement>('[data-download-handoff]').forEach((element) => element.addEventListener('click', () => {
    const plan = currentDisplayPlan();
    if (!plan) return;
    const downloaded = element.dataset.downloadHandoff === 'html' ? downloadHandoff(plan) : downloadHandoffJson(plan);
    showTray(downloaded ? 'Download ready' : 'Download unavailable', downloaded ? 'The kit is local and contains no executable script, secret, or delivery claim.' : 'Use the preview and copy controls to save the kit manually.', downloaded ? 'success' : 'warning');
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-download-calendar]').forEach((element) => element.addEventListener('click', () => {
    const plan = currentDisplayPlan();
    if (!plan) return;
    if (plan.status !== 'ACTIVE' && plan.status !== 'GRACE') {
      showTray('Owner reminder unavailable', 'This plan is already past D. A new owner reminder requires a fresh live chain state.', 'warning');
      return;
    }
    const now = reminderClockNow(plan);
    if (now === null) {
      showTray('Fresh chain read required', 'This live plan is stale. Refresh the plan before creating a reminder from its current deadline.', 'warning');
      return;
    }
    const reminderAt = Number(plan.lastHeartbeat) + Number(plan.inactivityPeriod) - getReminderLead(Number(plan.inactivityPeriod));
    if (reminderAt <= now) {
      openReminderPicker(plan, element, now);
      return;
    }
    const downloaded = downloadText(`lastlight-reminder-${plan.chainId}-${plan.vaultId.toString()}.ics`, buildReminderIcs(plan, Number(plan.lastHeartbeatBlock ?? 0n)), 'text/calendar;charset=utf-8');
    showTray(downloaded ? 'Calendar file ready' : 'Download unavailable', downloaded ? 'This is one local reminder. It does not sync when the owner checks in.' : 'Copy the reminder time and plan link instead. The chain state remains unchanged.', downloaded ? 'success' : 'warning', downloaded ? undefined : copyDetailsAction(ownerReminderDetails(plan, reminderAt)));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-download-recipient-calendar]').forEach((element) => element.addEventListener('click', () => {
    const plan = currentDisplayPlan();
    if (!plan) return;
    const downloaded = downloadText(`lastlight-claim-reminder-${plan.chainId}-${plan.vaultId.toString()}.ics`, buildRecipientIcs(plan, Number(plan.lastHeartbeatBlock ?? 0n)), 'text/calendar;charset=utf-8');
    showTray(downloaded ? 'Calendar file ready' : 'Download unavailable', downloaded ? 'The event is a reminder to check the chain. It does not prove eligibility.' : 'Copy the claim date and recipient link instead. The chain state remains authoritative.', downloaded ? 'success' : 'warning', downloaded ? undefined : copyDetailsAction(recipientReminderDetails(plan)));
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-download-receipt], .js-proof-download').forEach((element) => element.addEventListener('click', () => {
    const plan = currentDisplayPlan();
    if (!plan) return;
    const downloaded = downloadReceipt(plan, { transactionHash: plan.transactionHash, blockNumber: plan.transactionBlockNumber?.toString(), note: plan.source === 'recorded' ? 'Recorded view; no transaction is broadcast by this page.' : plan.transactionHash ? 'Receipt hash was matched to the configured contract and current wallet action.' : 'Current chain state read; no local receipt is attached to this view.' });
    showTray(downloaded ? 'Receipt export ready' : 'Download unavailable', downloaded ? (plan.transactionHash ? 'The export includes the locally matched receipt hash.' : 'The export labels this as a current chain state read without inventing a transaction hash.') : 'The receipt is still visible on this page; use the browser print or copy controls instead.', downloaded ? 'success' : 'warning');
  }));
}

window.addEventListener('hashchange', () => render());
window.addEventListener('load', () => render());
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') render();
  else {
    disposeRoutePresentation();
    if (livePollTimer !== undefined) { window.clearInterval(livePollTimer); livePollTimer = undefined; }
  }
});
window.addEventListener('focus', () => {
  if (document.visibilityState !== 'visible') return;
  const route = parseRoute();
  if (isLivePlanRoute(route)) void hydrateLivePlan(route);
  if (route.name === 'plans' && state.wallet.connected) void hydrateLivePlans(true, true);
  void reconcileTransactions();
});
if (document.readyState !== 'loading') { render(); void reconcileTransactions(); }
