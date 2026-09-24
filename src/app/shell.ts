import { chains, DEFAULT_CHAIN, MAINNET_READY, chainName, manifests } from './config';
import type { AppState } from './state';
import { navigate } from './router';
import type { DiscoveredWallet } from '../chain/wallet';
import { escapeHtml, icon } from '../components/ui';
import { shortAddress } from '../domain/address';
import { saveDraft } from '../storage/local';
import type { ChainId, TransactionState } from '../domain/types';

let unsubscribeWalletEvents: (() => void) | undefined;
let walletConnectionPending = false;

function invalidateDraftReview(state: AppState): void {
  state.draft.acknowledgements = [false, false];
  state.draft.shortTimingAcknowledgement = false;
  if (state.draft.step === 3) state.draft.step = 0;
  if (!saveDraft(state.draft, state.draftPersistenceEnabled)) state.storageAvailable = false;
}

function clearWalletView(state: AppState): void {
  state.activePlan = undefined;
  state.activePlanError = undefined;
  state.activePlanDiagnostic = undefined;
  state.livePlans = [];
  state.plansLoading = false;
  state.plansError = undefined;
  state.plansLoadedIds = [];
  state.plansNextOffset = 0n;
  state.plansQuery = '';
  state.plansTotal = 0n;
  state.plansObservedBlock = undefined;
  state.planRowErrors = {};
  state.planRowDiagnostics = {};
  state.plansDiagnostic = undefined;
  state.walletBalance = undefined;
  state.walletBalanceError = undefined;
  state.walletBalanceLoading = false;
  state.walletBalanceVersion += 1;
  state.createChainObservation = undefined;
  state.createFeeEstimate = undefined;
  state.createFeeEstimateError = undefined;
  state.actionFeeEstimate = undefined;
  state.actionFeeEstimateError = undefined;
}

function transactionStatusLabel(status: TransactionState['status']): string {
  return {
    idle: 'Idle', validating: 'Validating', simulating: 'Simulating', 'review-ready': 'Review ready', 'awaiting-wallet': 'Awaiting wallet', submitted: 'Submitted', confirming: 'Confirming', confirmed: 'Confirmed', rejected: 'Wallet rejected', failed: 'Failed', unknown: 'Unknown', 'pending-timeout': 'Still waiting', 'broadcast-unknown': 'Broadcast unknown', repriced: 'Repriced', replaced: 'Replaced', 'cancelled-replacement': 'Replacement cancelled', 'simulation-reverted': 'Simulation reverted', 'wrong-network': 'Wrong network', 'rpc-unavailable': 'RPC unavailable', 'onchain-reverted': 'On-chain reverted', reorged: 'Reorged; check status',
  }[status];
}

export function renderShell(content: string, state: AppState, routeName: string, routeChainId?: number): string {
  const walletLabel = state.wallet.connected && state.wallet.account ? shortAddress(state.wallet.account) : 'Connect wallet';
  const localAnvilAvailable = import.meta.env.DEV;
  const routeChain = routeChainId === 968 || routeChainId === 677 || (localAnvilAvailable && routeChainId === 31337) ? routeChainId as ChainId : undefined;
  const selectedChainId = state.wallet.chainId === 968 || state.wallet.chainId === 677 || (localAnvilAvailable && state.wallet.chainId === 31337)
    ? state.wallet.chainId
    : routeChain ?? DEFAULT_CHAIN;
  const selectedChain = chains[selectedChainId];
  const selectedManifest = manifests[selectedChainId];
  const unsupportedChainOption = state.wallet.chainId && state.wallet.chainId !== 968 && state.wallet.chainId !== 677 && !(localAnvilAvailable && state.wallet.chainId === 31337)
    ? `<option value="${state.wallet.chainId}" selected>Unsupported · ${state.wallet.chainId}</option>`
    : '';
  const localAnvilOption = localAnvilAvailable ? `<option value="31337" ${selectedChainId === 31337 ? 'selected' : ''}>Local Anvil</option>` : '';
  const testnetReady = Boolean(manifests[968].contractAddress && manifests[968].verificationStatus === 'verified');
  const showNetworkSelector = localAnvilAvailable || (MAINNET_READY && testnetReady) || Boolean(unsupportedChainOption) || (state.wallet.connected && selectedChainId !== DEFAULT_CHAIN);
  const networkControl = showNetworkSelector
    ? `<label class="network-select footer-network-select"><span class="sr-only">Network</span><select id="network-select" aria-label="Network">${unsupportedChainOption}<option value="968" ${selectedChainId === 968 ? 'selected' : ''}>BOT Testnet</option>${MAINNET_READY || selectedChainId === 677 ? `<option value="677" ${selectedChainId === 677 ? 'selected' : ''}>BOT Mainnet</option>` : ''}${localAnvilOption}</select></label>`
    : `<span class="footer-current-network">${escapeHtml(selectedChain.name)}</span>`;
  const headerNetworkLabel = unsupportedChainOption ? 'Unsupported network' : selectedChain.shortName;
  const pendingTransactions = state.transactions.filter(({ transaction }) => ['validating', 'simulating', 'review-ready', 'submitted', 'confirming', 'unknown', 'pending-timeout', 'broadcast-unknown', 'repriced', 'replaced', 'reorged', 'awaiting-wallet'].includes(transaction.status)).length;
  const recentTransactions = state.transactions.filter(({ transaction }) => transaction.status !== 'idle').slice(0, 4);
  const transactionCenter = recentTransactions.length ? `<div class="transaction-center" aria-label="Recent transaction status"><strong>Transaction status</strong>${recentTransactions.map(({ transaction }) => `<div class="transaction-center__row"><span>${escapeHtml(transaction.action ?? 'Action')}</span><small>${escapeHtml(transactionStatusLabel(transaction.status))}${transaction.hash ? ` · ${escapeHtml(`${transaction.hash.slice(0, 10)}…`)}` : ''}</small></div>`).join('')}</div>` : '';
  const walletGuidance = state.wallet.error?.startsWith('No wallet browser was found')
    ? `<div class="wallet-help" role="note"><span>Open this page in a wallet-enabled browser or extension.</span><button class="button button--quiet wallet-help__copy js-copy" data-copy="${escapeHtml(window.location.href)}" type="button">${icon('copy')}<span>Copy page link</span></button></div>`
    : '';
  const headerNetworkTone = unsupportedChainOption ? 'header-network--warning' : selectedManifest.contractAddress && selectedManifest.verificationStatus === 'verified' ? 'header-network--ready' : '';
  const walletControl = state.wallet.connected && state.wallet.account
    ? `<details class="wallet-account"><summary class="button button--primary wallet-button" aria-label="Wallet ${escapeHtml(walletLabel)}. Open account options">${icon('wallet')}<span>${escapeHtml(walletLabel)}</span></summary><div class="wallet-account__menu"><span class="wallet-account__eyebrow">Connected wallet</span><strong>${escapeHtml(state.wallet.providerName ?? 'Browser wallet')}</strong><small>${escapeHtml(walletLabel)}</small><button type="button" data-change-wallet>Change wallet</button><button type="button" data-disconnect-wallet>Disconnect from Lastlight</button><p>Switch accounts in your wallet extension. Disconnecting here ends this site's session; manage site permissions in the extension.</p></div></details>`
    : `<button class="button button--primary wallet-button" id="connect-wallet" type="button" aria-label="${state.wallet.connecting ? 'Connecting wallet' : 'Connect wallet'}" ${state.wallet.connecting ? 'disabled' : ''}>${icon('wallet')}<span>${state.wallet.connecting ? 'Connecting…' : 'Connect wallet'}</span></button>`;
  const headerControls = `<span class="header-network ${headerNetworkTone}" aria-label="Current network: ${escapeHtml(headerNetworkLabel)}"><span class="header-network__dot"></span>${escapeHtml(headerNetworkLabel)}</span>${pendingTransactions ? `<button class="header-pending" type="button" data-reconcile-transactions>${pendingTransactions} pending</button>` : ''}${walletControl}`;
  const localDataControl = `<details class="footer-utility"><summary>Data & transactions</summary><div class="footer-utility__panel"><small>Drafts are saved only when you opt in. Labels and action notes stay in this browser.</small>${transactionCenter}${pendingTransactions ? `<small>${pendingTransactions} transaction record${pendingTransactions === 1 ? '' : 's'} need${pendingTransactions === 1 ? 's' : ''} checking.</small><button type="button" data-reconcile-transactions>Check transaction status</button>` : ''}<button type="button" data-clear-local-data>Clear local data</button></div></details>`;
  return `<div class="app-shell">
    <header class="site-header"><div class="shell-width site-header__inner">
      <a href="#/" class="wordmark" aria-label="Lastlight home"><img class="wordmark__mark" src="./assets/lastlight-mark.png" alt="" width="40" height="40"><span class="wordmark__text">Lastlight</span></a>
      <nav class="desktop-nav" aria-label="Primary navigation"><a class="${routeName === 'home' ? 'is-current' : ''}" ${routeName === 'home' ? 'aria-current="page"' : ''} href="#/">Overview</a><a class="${routeName === 'plans' ? 'is-current' : ''}" ${routeName === 'plans' ? 'aria-current="page"' : ''} href="#/plans">My plans</a><a class="${routeName === 'create' ? 'is-current' : ''}" ${routeName === 'create' ? 'aria-current="page"' : ''} href="#/create">Create plan</a></nav>
      <div class="header-actions">${headerControls}${state.wallet.error ? `<p class="wallet-error" role="status">${escapeHtml(state.wallet.error)}</p>` : ''}${walletGuidance}
    </div></div><nav class="mobile-nav shell-width" aria-label="Mobile navigation"><a class="${routeName === 'home' ? 'is-current' : ''}" ${routeName === 'home' ? 'aria-current="page"' : ''} href="#/">Overview</a><a class="${routeName === 'plans' ? 'is-current' : ''}" ${routeName === 'plans' ? 'aria-current="page"' : ''} href="#/plans">My plans</a><a class="${routeName === 'create' ? 'is-current' : ''}" ${routeName === 'create' ? 'aria-current="page"' : ''} href="#/create">Create plan</a></nav></header>
    <main id="main-content" tabindex="-1">${content}</main>
    <div id="transaction-tray" class="transaction-tray" role="status" aria-live="polite" aria-atomic="true" hidden></div>
    <footer class="site-footer"><div class="shell-width footer-grid"><div><a href="#/" class="wordmark wordmark--footer"><img class="wordmark__mark" src="./assets/lastlight-mark.png" alt="" width="36" height="36"><span class="wordmark__text">Lastlight</span></a><p>Owner-controlled continuity plans.</p></div><div><p class="footer-label">Workspace</p><a href="#/create">Create plan</a><a href="#/plans">My plans</a><a href="#/launch">Deployment status</a>${localDataControl}</div><div><p class="footer-label">Network</p>${networkControl}<span class="footer-muted">${selectedManifest.contractAddress && selectedManifest.verificationStatus === 'verified' ? 'Deployment verified' : 'Deployment pending'}</span><a href="https://botchain.ai" target="_blank" rel="noreferrer">BOT Chain ${icon('external')}</a><a href="${escapeHtml(selectedChain.explorerUrl)}" target="_blank" rel="noreferrer">${escapeHtml(selectedChain.shortName)} Explorer ${icon('external')}</a></div></div><div class="shell-width footer-bottom"><span>© ${new Date().getFullYear()} Lastlight</span></div></footer>
  </div>`;
}

export function bindShell(state: AppState, onStateChange: () => void): void {
  document.querySelector<HTMLButtonElement>('#connect-wallet')?.addEventListener('click', () => { void connectWallet(state, onStateChange, false); });
  document.querySelector<HTMLButtonElement>('[data-change-wallet]')?.addEventListener('click', () => {
    document.querySelector<HTMLDetailsElement>('.wallet-account')?.removeAttribute('open');
    void connectWallet(state, onStateChange, true);
  });
  document.querySelector<HTMLButtonElement>('[data-disconnect-wallet]')?.addEventListener('click', async () => {
    const { clearSelectedProvider } = await import('../chain/wallet');
    unsubscribeWalletEvents?.();
    unsubscribeWalletEvents = undefined;
    clearSelectedProvider();
    state.wallet = { connected: false, connecting: false, chainId: state.wallet.chainId };
    invalidateDraftReview(state);
    clearWalletView(state);
    onStateChange();
    document.querySelector<HTMLButtonElement>('#connect-wallet')?.focus();
  });
  document.querySelector<HTMLSelectElement>('#network-select')?.addEventListener('change', (event) => {
    const value = Number((event.target as HTMLSelectElement).value);
    const previous = state.wallet.chainId;
    if (state.wallet.connected) {
      void switchSelectedNetwork(value, previous, state, onStateChange);
      return;
    }
    state.wallet = { ...state.wallet, chainId: value };
    invalidateDraftReview(state);
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
    state.walletBalance = undefined;
    state.walletBalanceError = undefined;
    state.walletBalanceLoading = false;
    state.walletBalanceVersion += 1;
    state.createChainObservation = undefined;
    state.createFeeEstimate = undefined;
    state.createFeeEstimateError = undefined;
    state.actionFeeEstimate = undefined;
    state.actionFeeEstimateError = undefined;
    onStateChange();
    const label = chainName(value);
    document.querySelector('#transaction-tray')?.removeAttribute('hidden');
    const tray = document.querySelector('#transaction-tray');
    if (tray) tray.innerHTML = `<div class="tray-inner"><span class="tray-icon">${icon('clock')}</span><div><strong>${escapeHtml(label)} selected</strong><span>Wallet writes stay disabled until a verified deployment is configured.</span></div><button class="tray-close" aria-label="Dismiss">×</button></div>`;
    tray?.querySelector('.tray-close')?.addEventListener('click', () => tray.setAttribute('hidden', 'true'));
  });
}

async function connectWallet(state: AppState, onStateChange: () => void, switching: boolean): Promise<void> {
  if (walletConnectionPending) return;
  walletConnectionPending = true;
  const previousWallet = state.wallet;
  if (!switching) {
    state.wallet = { ...previousWallet, connecting: true, error: undefined };
    onStateChange();
  }
  try {
    const { connectInjectedWallet, discoverWalletProviders, getInjectedProvider, subscribeWallet } = await import('../chain/wallet');
    const providers = await discoverWalletProviders();
    const selected = await chooseWalletProvider(providers, switching);
    if (!selected) {
      state.wallet = switching ? previousWallet : { connected: false, connecting: false, chainId: previousWallet.chainId, error: providers.length ? undefined : 'No wallet browser was found. Use a wallet-enabled browser or extension; public reads remain available.' };
      onStateChange();
      return;
    }
    const connected = await connectInjectedWallet(selected.provider, selected.name);
    if (!connected.connected) {
      state.wallet = switching ? { ...previousWallet, error: connected.error } : connected;
      onStateChange();
      return;
    }
    unsubscribeWalletEvents?.();
    unsubscribeWalletEvents = undefined;
    state.wallet = connected;
    invalidateDraftReview(state);
    clearWalletView(state);
    const provider = getInjectedProvider();
    if (provider) unsubscribeWalletEvents = subscribeWallet(provider, {
      accountsChanged: (accounts) => {
        const account = accounts[0]?.toLowerCase() as `0x${string}` | undefined;
        state.wallet = { ...state.wallet, connected: Boolean(account), account, providerName: account ? state.wallet.providerName : undefined };
        invalidateDraftReview(state);
        clearWalletView(state);
        onStateChange();
      },
      chainChanged: (chainId) => {
        state.wallet = { ...state.wallet, chainId };
        invalidateDraftReview(state);
        clearWalletView(state);
        onStateChange();
      },
    });
    onStateChange();
  } catch {
    state.wallet = switching ? { ...previousWallet, error: 'Could not change wallets. Try again.' } : { connected: false, connecting: false, chainId: previousWallet.chainId, error: 'Wallet connection failed. Try again.' };
    onStateChange();
  } finally {
    walletConnectionPending = false;
  }
}

function chooseWalletProvider(providers: DiscoveredWallet[], switching = false): Promise<DiscoveredWallet | undefined> {
  if (!providers.length || (providers.length === 1 && !switching)) return Promise.resolve(providers[0]);
  const id = 'wallet-provider-picker';
  document.getElementById(id)?.remove();
  document.body.insertAdjacentHTML('beforeend', `<dialog class="wallet-picker" id="${id}" aria-labelledby="wallet-picker-title"><form method="dialog"><button class="dialog-close icon-button" value="cancel" aria-label="Close wallet picker">×</button><p class="eyebrow">${switching ? 'Change wallet' : 'Connect wallet'}</p><h2 id="wallet-picker-title">Choose a browser wallet.</h2><p class="dialog-description">${switching ? 'Select another wallet, or switch accounts in your wallet extension and choose it here again.' : 'Use the provider you select for this session. Lastlight does not request a connection until you choose one.'}</p><div class="wallet-picker__options">${providers.map((provider) => `<button class="button button--secondary" type="button" data-wallet-provider="${escapeHtml(provider.id)}">${icon('wallet')}<span>${escapeHtml(provider.name)}</span></button>`).join('')}</div></form></dialog>`);
  const dialog = document.getElementById(id);
  if (!(dialog instanceof HTMLDialogElement)) return Promise.resolve(providers[0]);
  dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('[data-wallet-provider]')?.focus();
  return new Promise((resolve) => {
    let settled = false;
    const restoreFocus = () => window.setTimeout(() => (document.querySelector<HTMLElement>('.wallet-account summary') ?? document.querySelector<HTMLElement>('#connect-wallet'))?.focus(), 0);
    const finish = (value?: DiscoveredWallet) => {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    };
    dialog.querySelectorAll<HTMLButtonElement>('[data-wallet-provider]').forEach((button) => button.addEventListener('click', () => finish(providers.find((provider) => provider.id === button.dataset.walletProvider))));
    dialog.addEventListener('close', () => { dialog.remove(); if (!settled) { settled = true; resolve(undefined); } restoreFocus(); }, { once: true });
  });
}

async function switchSelectedNetwork(value: number, previous: number | undefined, state: AppState, onStateChange: () => void): Promise<void> {
  const { switchToChain } = await import('../chain/wallet');
  const result = await switchToChain(value);
  if (result.ok) {
    state.wallet = { ...state.wallet, chainId: value };
    invalidateDraftReview(state);
    state.walletBalance = undefined;
    state.walletBalanceError = undefined;
    state.walletBalanceLoading = false;
    state.walletBalanceVersion += 1;
    state.createChainObservation = undefined;
    state.createFeeEstimate = undefined;
    state.createFeeEstimateError = undefined;
    state.actionFeeEstimate = undefined;
    state.actionFeeEstimateError = undefined;
    onStateChange();
    return;
  }
  onStateChange();
  const tray = document.querySelector<HTMLDivElement>('#transaction-tray');
  if (!tray) return;
  tray.hidden = false;
  tray.innerHTML = `<div class="tray-inner tray-inner--warning"><span class="tray-icon">${icon('warning')}</span><div><strong>Network switch declined</strong><span>${escapeHtml(result.error ?? `Stay on ${previous ? chainName(previous) : 'the current network'} and continue in read-only mode.`)}</span></div><button class="tray-close" type="button" aria-label="Dismiss notification">×</button></div>`;
  tray.querySelector('.tray-close')?.addEventListener('click', () => { tray.hidden = true; });
}
