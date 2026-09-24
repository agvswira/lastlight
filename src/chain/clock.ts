import { getPublicClient } from './client';
import type { ChainId, Observation } from '../domain/types';

export type FreshBlock = Observation & { chainId: ChainId };

export async function readFreshBlock(chainId: ChainId): Promise<FreshBlock> {
  const client = getPublicClient(chainId);
  const block = await client.getBlock({ blockTag: 'latest' });
  return {
    chainId,
    blockNumber: block.number,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    receivedAtMonotonicMs: performance.now(),
  };
}

export function isObservationStale(observation: Observation | undefined, now = performance.now(), maxAgeMs = 20_000): boolean {
  return !observation || now - observation.receivedAtMonotonicMs > maxAgeMs;
}
