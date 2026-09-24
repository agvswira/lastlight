import type { AppState } from '../app/state';
import { button, diagnosticDetails, escapeHtml, icon } from '../components/ui';
import { shortAddress } from '../domain/address';
import { formatDate } from '../domain/policy';
import type { Plan, PlanStatus } from '../domain/types';
import { networkBadge, planCard, inlineNotice } from './shared';
import { MAINNET_ONLY, manifests } from '../app/config';

export function planPriority(role: AppState['planRole'], status: PlanStatus): number {
  const priority: Record<PlanStatus, number> = role === 'owner'
    ? { GRACE: 0, ACTIVE: 1, CLAIMABLE: 2, CANCELLED: 3, CLAIMED: 4 }
    : { CLAIMABLE: 0, GRACE: 1, ACTIVE: 1, CANCELLED: 2, CLAIMED: 2 };
  return priority[status];
}

export function sortPlansForRole(plans: Plan[], role: AppState['planRole']): Plan[] {
  return [...plans].sort((a, b) => planPriority(role, a.status) - planPriority(role, b.status)
    || (a.claimableAt < b.claimableAt ? -1 : a.claimableAt > b.claimableAt ? 1 : a.vaultId < b.vaultId ? -1 : a.vaultId > b.vaultId ? 1 : 0));
}

export function renderPlans(state: AppState): string {
  const connected = state.wallet.connected;
  const chainId = state.wallet.chainId;
  const wrongNetwork = MAINNET_ONLY && connected && chainId !== 677;
  const liveDeployment = chainId === 968 || chainId === 677 || chainId === 31337 ? manifests[chainId].contractAddress : null;
  const sortedPlans = sortPlansForRole(state.livePlans, state.planRole);
  const query = state.plansQuery.trim().toLowerCase();
  const filteredPlans = query ? sortedPlans.filter((plan) => plan.vaultId.toString().includes(query) || (plan.label ?? '').toLowerCase().includes(query)) : sortedPlans;
  const planHref = (plan: Plan) => `#/${state.planRole === 'successor' ? 'receive' : 'plan'}/${plan.chainId}/${plan.contract}/${plan.vaultId.toString()}`;
  const liveRows = filteredPlans.map((plan) => planCard(plan, planHref(plan), plan.source === 'chain' ? 'Loaded from one observed block' : undefined, state.planRole === 'successor' && plan.source === 'chain' && !plan.label ? `Created by ${plan.owner}` : undefined)).join('');
  const loadedIds = new Set(state.livePlans.map((plan) => plan.vaultId.toString()));
  const failedRows = state.plansLoadedIds
    .filter((id) => !loadedIds.has(id.toString()) && (!query || id.toString().includes(query)))
    .map((id) => `<article class="plan-row plan-row--error"><div class="plan-row__main"><div class="plan-row__top"><span class="plan-row__number">Plan #${escapeHtml(id)}</span><span class="status-pill status-pill--terminal"><span class="status-pill__dot"></span>Read unavailable</span></div><h3>This plan needs a fresh read.</h3><p>${escapeHtml(state.planRowErrors[id.toString()] ?? 'The selected RPC did not return this plan.')}</p>${diagnosticDetails(state.planRowDiagnostics[id.toString()])}</div><button class="button button--quiet plan-row__open" type="button" data-retry-plan="${escapeHtml(id)}">Retry read ${icon('arrow')}</button></article>`)
    .join('');
  const allRows = `${liveRows}${failedRows}`;
  const retryListAction = `<button class="button button--quiet" type="button" data-retry-plans>Retry list ${icon('arrow')}</button>`;
  const attentionPlan = state.planRole === 'owner' ? sortedPlans.find((plan) => plan.status === 'GRACE') : sortedPlans.find((plan) => plan.status === 'CLAIMABLE');
  const attentionRegion = attentionPlan
    ? `<section class="attention-region"><div><span class="panel-kicker">Action needed</span><h2>${state.planRole === 'owner' ? 'A plan needs your check-in.' : 'A plan is ready to claim.'}</h2><p>Plan #${escapeHtml(attentionPlan.vaultId)} · ${state.planRole === 'owner' ? `Your control ends ${escapeHtml(formatDate(attentionPlan.claimableAt, true, true))}.` : 'Review the current chain state before signing.'}</p></div><a class="button button--secondary" href="${planHref(attentionPlan)}">Open plan ${icon('arrow')}</a></section>`
    : '';
  let personalContent: string;
  if (wrongNetwork) {
    personalContent = `<section class="empty-state page-empty-state page-empty-state--connect"><div class="page-empty-state__copy"><div><h2>Switch your wallet to Mainnet</h2><p>Lastlight plans are available on BOT Chain Mainnet.</p></div><button class="button button--secondary" type="button" data-switch-mainnet>Switch to Mainnet ${icon('arrow')}</button></div></section>`;
  } else if (!connected) {
    personalContent = `<section class="empty-state page-empty-state page-empty-state--connect"><div class="page-empty-state__copy"><div><span class="panel-kicker">Your space</span><h2>Connect to see your plans</h2><p>Connect your wallet to see plans you created or can claim.</p></div></div><div class="page-empty-state__actions">${button('Connect wallet', { className: 'js-shell-connect', icon: 'wallet' })}</div></section>`;
  } else if (!liveDeployment) {
    const onMainnet = chainId === 677;
    const title = onMainnet ? 'Your wallet is on BOT Mainnet' : 'No deployment configured for this network';
    const message = onMainnet
      ? 'Lastlight is deployed on BOT Testnet. Switch your wallet to Testnet to see or create test plans; no plan data is inferred from Mainnet.'
      : 'Lastlight has no configured contract on this wallet network. Switch to BOT Testnet to use the test deployment.';
    personalContent = `<div class="network-switch-notice">${inlineNotice(title, message, 'warning')}${manifests[968].contractAddress ? button('Switch to BOT Testnet', { variant: 'secondary', className: 'js-switch-testnet', icon: 'arrow' }) : ''}</div>`;
  } else if (state.plansLoading) {
    personalContent = `<div class="list-loading" role="status"><span class="loading-bar"></span><p>Loading your plans…</p></div>`;
  } else if (state.plansError && !allRows) {
    personalContent = `${inlineNotice('Could not load the list', state.plansError, 'warning', state.plansDiagnostic)}${retryListAction}`;
  } else if (allRows) {
    const more = state.plansNextOffset < state.plansTotal ? `<button class="button button--quiet load-more" type="button" data-load-more>Load more 20 ${icon('arrow')}</button>` : '';
    personalContent = `${state.plansError ? `${inlineNotice('Some rows need a retry', state.plansError, 'warning', state.plansDiagnostic)}${retryListAction}` : ''}${attentionRegion}<section class="live-plan-list"><div class="section-heading section-heading--row"><div><span class="panel-kicker">Loaded plans</span><h2>${state.planRole === 'owner' ? 'Plans created by me' : 'Plans for me'}</h2></div><span class="loaded-count">Showing ${filteredPlans.length} of ${state.plansTotal.toString()}</span></div><div class="plan-list">${allRows}</div>${more}</section>`;
  } else if (query && state.livePlans.length) {
    personalContent = `<section class="empty-state page-empty-state"><h2>No plan matches “${escapeHtml(state.plansQuery)}”.</h2><p>Search only covers plans loaded for this wallet and network.</p></section>`;
  } else {
    personalContent = `<section class="plans-empty-message"><h2>No plans yet</h2><p>Plans for this wallet will appear here.</p></section>`;
  }
  const showSearch = connected && !state.plansLoading && (state.livePlans.length > 0 || state.plansLoadedIds.length > 0);
  const connectedToolbar = connected && !wrongNetwork ? `<div class="plans-toolbar"><div class="connected-context"><span class="connected-context__dot"></span><span>Viewing wallet <strong>${escapeHtml(shortAddress(state.wallet.account ?? ''))}</strong></span>${networkBadge(state.wallet.chainId ?? 968)}</div>${showSearch ? `<form class="plans-search" data-plans-search-form><label class="field__label" for="plans-search">Search loaded plans</label><div class="input-with-action"><input id="plans-search" name="q" type="search" value="${escapeHtml(state.plansQuery)}" placeholder="Plan ID or local label"><button class="input-action" type="submit">Search</button></div><small class="field__help">Search covers plans loaded for this wallet and network.</small></form>` : ''}</div>` : '';
  return `<div class="plans-page"><section class="product-hero"><div class="shell-width product-hero__inner"><div class="product-hero__copy"><h1>My plans</h1><p class="lede">Plans you created and plans made for you, in one place.</p></div><img class="product-hero__art" src="./assets/lastlight-hero.webp" alt="" aria-hidden="true"></div></section><section class="shell-width plans-content"><div class="plans-topbar"><div class="plan-tabs" role="tablist" aria-label="Plan role"><button type="button" role="tab" class="plan-tab ${state.planRole === 'owner' ? 'is-active' : ''}" id="plans-tab-owner" aria-controls="plans-panel" aria-selected="${state.planRole === 'owner'}" tabindex="${state.planRole === 'owner' ? '0' : '-1'}" data-plan-role="owner">Created by me</button><button type="button" role="tab" class="plan-tab ${state.planRole === 'successor' ? 'is-active' : ''}" id="plans-tab-successor" aria-controls="plans-panel" aria-selected="${state.planRole === 'successor'}" tabindex="${state.planRole === 'successor' ? '0' : '-1'}" data-plan-role="successor">For me</button></div>${button('Create plan', { href: '#/create', icon: 'plus', className: 'plans-create-action' })}</div><div id="plans-panel" role="tabpanel" aria-labelledby="plans-tab-${state.planRole}">${connectedToolbar}${personalContent}</div></section></div>`;
}
