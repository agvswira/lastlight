import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import { chains, manifests } from '../app/config';
import type { ChainId } from '../domain/types';

const clients = new Map<ChainId, PublicClient>();

export function getPublicClient(chainId: ChainId): PublicClient {
  const existing = clients.get(chainId);
  if (existing) return existing;
  const network = chains[chainId];
  const rpcUrl = manifests[chainId].rpcUrl || network.rpcUrl;
  const chain = defineChain({
    id: chainId,
    name: network.name,
    nativeCurrency: { name: 'BOT', symbol: network.symbol, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'BOT Explorer', url: network.explorerUrl } },
  });
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 15_000 }),
  });
  clients.set(chainId, client);
  return client;
}

export function hasDeployment(chainId: ChainId): boolean {
  return manifests[chainId].contractAddress !== null;
}
