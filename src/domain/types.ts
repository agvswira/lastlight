export type ChainId = 968 | 677 | 31337;
export type ViewSource = 'chain' | 'rehearsal' | 'recorded';
export type PlanStatus = 'ACTIVE' | 'GRACE' | 'CLAIMABLE' | 'CANCELLED' | 'CLAIMED';
export type Settlement = 'NONE' | 'CANCELLED' | 'CLAIMED';
export type RehearsalAction = 'keep-checking-in' | 'miss-check-in' | 'return-during-grace' | 'let-deadline-pass';
export type DurationUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export type PlanKey = {
  chainId: ChainId;
  contract: `0x${string}`;
  vaultId: bigint;
};

export type Observation = {
  blockNumber: bigint;
  blockHash: `0x${string}`;
  blockTimestamp: bigint;
  receivedAtMonotonicMs: number;
};

export type Plan = PlanKey & {
  owner: `0x${string}`;
  successor: `0x${string}`;
  previousSuccessor?: `0x${string}`;
  settlementRecipient?: `0x${string}`;
  depositedAmount: bigint;
  amount: bigint;
  createdAt: bigint;
  lastHeartbeat: bigint;
  inactivityPeriod: bigint;
  gracePeriod: bigint;
  settledAt?: bigint;
  createdBlock?: bigint;
  lastHeartbeatBlock?: bigint;
  successorChangedBlock?: bigint;
  settledBlock?: bigint;
  settlement: Settlement;
  status: PlanStatus;
  checkInBy: bigint;
  claimableAt: bigint;
  observation?: Observation;
  source: ViewSource;
  transactionHash?: `0x${string}`;
  transactionBlockNumber?: bigint;
  transactions?: ReceiptEvidence[];
  label?: string;
  recordedLabel?: string;
};

export type ReceiptEvidence = {
  action?: string;
  hash: `0x${string}`;
  nonce?: string;
  blockNumber?: string;
  blockHash?: `0x${string}`;
  blockTimestamp?: string;
  confirmations?: string;
  receiptStatus?: 'success' | 'reverted';
  eventName?: string;
  eventArgs?: Record<string, string>;
  gasUsed?: string;
  effectiveGasPrice?: string;
  feeWei?: string;
};

export type FeeEstimate = {
  intentKey: string;
  chainId: ChainId;
  contract: `0x${string}`;
  account: `0x${string}`;
  gasLimit: string;
  gasPriceWei: string;
  feeWei: string;
  valueWei: string;
  observedBlock?: string;
};

export type RehearsalView = {
  source: 'rehearsal';
  baseTimestamp: number;
  inactivityPeriod: number;
  gracePeriod: number;
  previewElapsed: number;
  status: PlanStatus;
  checkInBy: number;
  claimableAt: number;
  lastAction?: RehearsalAction;
  returnFrom?: number;
  returnTo?: number;
};

export type PlanDraft = {
  recipient: string;
  label: string;
  inactivityPeriod: number;
  gracePeriod: number;
  inactivityUnit?: DurationUnit;
  graceUnit?: DurationUnit;
  inactivityCustom?: boolean;
  graceCustom?: boolean;
  amount: string;
  step: 0 | 1 | 2 | 3;
  acknowledgements: [boolean, boolean];
  shortTimingAcknowledgement?: boolean;
};

export type WalletState = {
  account?: `0x${string}`;
  chainId?: number;
  connected: boolean;
  connecting: boolean;
  providerName?: string;
  error?: string;
};

export type TransactionState = {
  status: 'idle' | 'validating' | 'simulating' | 'review-ready' | 'awaiting-wallet' | 'submitted' | 'confirming' | 'confirmed' | 'rejected' | 'failed' | 'unknown' | 'pending-timeout' | 'broadcast-unknown' | 'repriced' | 'replaced' | 'cancelled-replacement' | 'simulation-reverted' | 'wrong-network' | 'rpc-unavailable' | 'onchain-reverted' | 'reorged';
  action?: string;
  account?: `0x${string}`;
  hash?: `0x${string}`;
  message?: string;
  chainId?: ChainId;
  contract?: `0x${string}`;
  vaultId?: string;
  method?: string;
  args?: string[];
  valueWei?: string;
  expectedRecipient?: `0x${string}`;
  expectedAmountWei?: string;
  inactivityPeriod?: string;
  gracePeriod?: string;
  nonce?: string;
  blockNumber?: string;
  blockHash?: `0x${string}`;
  blockTimestamp?: string;
  confirmations?: string;
  receiptStatus?: 'success' | 'reverted';
  eventName?: string;
  eventArgs?: Record<string, string>;
  gasUsed?: string;
  effectiveGasPrice?: string;
  feeWei?: string;
  startedAt?: string;
  updatedAt?: string;
};
