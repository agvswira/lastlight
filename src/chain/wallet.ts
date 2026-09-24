import type { WalletState } from '../domain/types';
import { chains, isSupportedChain } from '../app/config';

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type DiscoveredWallet = {
  id: string;
  name: string;
  provider: Eip1193Provider;
};

declare global {
  interface Window { ethereum?: Eip1193Provider; }
}

let selectedProvider: Eip1193Provider | undefined;
let discoveryPromise: Promise<DiscoveredWallet[]> | undefined;
const PROVIDER_KEY = 'lastlight:v1:wallet-provider';
const DISCONNECTED_KEY = 'lastlight:v1:wallet-disconnected';

function walletStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function rememberWalletProvider(id: string): void {
  try {
    const storage = walletStorage();
    storage?.setItem(PROVIDER_KEY, id);
    storage?.removeItem(DISCONNECTED_KEY);
  } catch {}
}

export function rememberWalletDisconnect(): void {
  try {
    const storage = walletStorage();
    storage?.removeItem(PROVIDER_KEY);
    storage?.setItem(DISCONNECTED_KEY, '1');
  } catch {}
}

function parseChainId(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value);
  return undefined;
}

export function getInjectedProvider(): Eip1193Provider | undefined {
  return selectedProvider ?? window.ethereum;
}

export function clearSelectedProvider(): void {
  selectedProvider = undefined;
}

export async function discoverWalletProviders(): Promise<DiscoveredWallet[]> {
  if (discoveryPromise) return discoveryPromise;
  discoveryPromise = new Promise<DiscoveredWallet[]>((resolve) => {
    const discovered = new Map<string, DiscoveredWallet>();
    const announce = (event: Event) => {
      const detail = (event as CustomEvent<{ info?: { uuid?: string; name?: string }; provider?: Eip1193Provider }>).detail;
      if (!detail?.provider) return;
      const id = detail.info?.uuid || `eip6963:${discovered.size}`;
      discovered.set(id, { id, name: detail.info?.name || 'Browser wallet', provider: detail.provider });
    };
    window.addEventListener('eip6963:announceProvider', announce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    window.setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', announce);
      if (!discovered.size && window.ethereum) discovered.set('legacy', { id: 'legacy', name: 'Browser wallet', provider: window.ethereum });
      const providers = [...discovered.values()];
      // Keep a no-provider result retryable: a mobile wallet or extension may
      // inject EIP-1193 after the first render.
      if (!providers.length) discoveryPromise = undefined;
      resolve(providers);
    }, 120);
  });
  return discoveryPromise;
}

export async function connectInjectedWallet(providerOverride?: Eip1193Provider, providerName?: string): Promise<WalletState> {
  const provider = providerOverride ?? getInjectedProvider();
  if (!provider) return { connected: false, connecting: false, error: 'No wallet browser was found. Public reads remain available.' };
  try {
    const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[];
    const chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
    const account = accounts[0]?.toLowerCase() as `0x${string}` | undefined;
    if (account) selectedProvider = provider;
    return { connected: Boolean(account), connecting: false, account, chainId, providerName: providerName ?? 'Browser wallet' };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return { connected: false, connecting: false, error: /denied|rejected|cancel/i.test(message) ? 'Connection cancelled in your wallet.' : 'Wallet connection failed. Try again from the wallet, or continue in read-only mode.' };
  }
}

export async function restoreAuthorizedWallet(): Promise<WalletState | null> {
  const storage = walletStorage();
  let preferredId: string | null = null;
  try {
    if (storage?.getItem(DISCONNECTED_KEY) === '1') return null;
    preferredId = storage?.getItem(PROVIDER_KEY) ?? null;
  } catch {}
  const providers = await discoverWalletProviders();
  const ordered = preferredId ? [...providers].sort((a, b) => Number(b.id === preferredId) - Number(a.id === preferredId)) : providers;
  for (const { provider, name } of ordered) {
    try {
      const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
      const account = accounts[0]?.toLowerCase() as `0x${string}` | undefined;
      if (!account) continue;
      const chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
      selectedProvider = provider;
      return { connected: true, connecting: false, account, chainId, providerName: name };
    } catch {}
  }
  return null;
}

export async function switchToChain(chainId: number): Promise<{ ok: boolean; error?: string }> {
  const provider = getInjectedProvider();
  if (!provider || !isSupportedChain(chainId)) return { ok: false, error: 'A supported wallet provider is required.' };
  const config = chains[chainId];
  const hexChainId = `0x${chainId.toString(16)}`;
  const verifySwitch = async (): Promise<{ ok: boolean; error?: string }> => {
    const actual = parseChainId(await provider.request({ method: 'eth_chainId' }));
    return actual === chainId ? { ok: true } : { ok: false, error: `The wallet stayed on chain ${actual ?? 'unknown'} after the network request.` };
  };
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChainId }] });
    return verifySwitch();
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : undefined;
    if (code !== 4902 && code !== '4902') return { ok: false, error: 'The wallet declined or could not complete the network switch.' };
    try {
      await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hexChainId, chainName: config.name, nativeCurrency: { name: 'BOT', symbol: config.symbol.replace('test ', ''), decimals: 18 }, rpcUrls: [config.rpcUrl], blockExplorerUrls: [config.explorerUrl] }] });
      return verifySwitch();
    } catch (addError) {
      return { ok: false, error: 'The wallet could not add this network.' };
    }
  }
}

export function subscribeWallet(provider: Eip1193Provider, callbacks: {
  accountsChanged: (accounts: string[]) => void;
  chainChanged: (chainId: number) => void;
}): () => void {
  const accountsListener = (...args: unknown[]) => callbacks.accountsChanged((args[0] as string[] | undefined) ?? []);
  const chainListener = (...args: unknown[]) => callbacks.chainChanged(parseChainId(args[0]) ?? 0);
  provider.on?.('accountsChanged', accountsListener);
  provider.on?.('chainChanged', chainListener);
  return () => {
    provider.removeListener?.('accountsChanged', accountsListener);
    provider.removeListener?.('chainChanged', chainListener);
  };
}
