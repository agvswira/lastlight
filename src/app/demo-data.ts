import { createRehearsal } from '../domain/rehearsal';
import type { Plan } from '../domain/types';

export const DEMO_CONTRACT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
export const DEMO_OWNER = '0x0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`;
export const DEMO_RECIPIENT = '0x0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
export const DEMO_RECIPIENT_2 = '0x0ccccccccccccccccccccccccccccccccccccccc' as `0x${string}`;

const demoBase = Math.floor(Date.now() / 1000) - (180 + 180);

export const DEMO_PLAN: Plan = {
  chainId: 968,
  contract: DEMO_CONTRACT,
  vaultId: 7n,
  owner: DEMO_OWNER,
  successor: DEMO_RECIPIENT,
  previousSuccessor: DEMO_RECIPIENT_2,
  depositedAmount: 10_000_000_000_000_000n,
  amount: 10_000_000_000_000_000n,
  createdAt: BigInt(demoBase),
  lastHeartbeat: BigInt(demoBase),
  inactivityPeriod: 180n,
  gracePeriod: 180n,
  status: 'CLAIMABLE',
  checkInBy: BigInt(demoBase + 180),
  claimableAt: BigInt(demoBase + 360),
  settlement: 'NONE',
  source: 'recorded',
  recordedLabel: 'Recorded testnet run · fixture only',
  observation: {
    blockNumber: 0n,
    blockHash: '0x' as `0x${string}`,
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    receivedAtMonotonicMs: performance.now(),
  },
};

export const DEMO_REHEARSAL = createRehearsal(Math.floor(Date.now() / 1000), 180, 180);

export function cloneDemoPlan(overrides: Partial<Plan> = {}): Plan {
  return { ...DEMO_PLAN, ...overrides };
}
