import { createRehearsal } from '../domain/rehearsal';
import type { FeeEstimate, Plan, PlanDraft, RehearsalView, TransactionState, WalletState } from '../domain/types';
import { hasLocalStorage, isDraftPersistenceEnabled, loadDraft, loadTransactions } from '../storage/local';
import { DEMO_REHEARSAL } from './demo-data';

export const defaultDraft: PlanDraft = {
  recipient: '', label: '', inactivityPeriod: 90 * 24 * 60 * 60, gracePeriod: 30 * 24 * 60 * 60, amount: '0.01', step: 0, acknowledgements: [false, false], shortTimingAcknowledgement: false,
};

export type AppState = {
  rehearsal: RehearsalView;
  builderRehearsal: RehearsalView;
  draft: PlanDraft;
  createValidationAttemptedStep?: 0 | 1 | 2 | 3;
  wallet: WalletState;
  homeScene: 'choose' | 'check-in' | 'handoff';
  activePlan?: Plan;
  activePlanError?: string;
  activePlanDiagnostic?: string;
  livePlans: Plan[];
  plansLoading: boolean;
  plansError?: string;
  plansDiagnostic?: string;
  planRole: 'owner' | 'successor';
  plansQuery: string;
  plansTotal: bigint;
  plansLoadedIds: bigint[];
  plansNextOffset: bigint;
  plansObservedBlock?: {
    blockNumber: bigint;
    blockTimestamp: bigint;
    blockHash: `0x${string}`;
  };
  planRowErrors: Record<string, string>;
  planRowDiagnostics: Record<string, string>;
  walletBalance?: bigint;
  walletBalanceLoading: boolean;
  walletBalanceError?: string;
  walletBalanceVersion: number;
  createFeeEstimate?: FeeEstimate;
  createFeeEstimateLoading: boolean;
  createFeeEstimateError?: string;
  createChainObservation?: {
    chainId: 968 | 677 | 31337;
    blockNumber: bigint;
    blockTimestamp: bigint;
    blockHash: `0x${string}`;
    receivedAtMonotonicMs: number;
  };
  actionFeeEstimate?: FeeEstimate;
  actionFeeEstimateLoading: boolean;
  actionFeeEstimateError?: string;
  storageAvailable: boolean;
  draftPersistenceEnabled: boolean;
  transactions: Array<{ key: string; transaction: TransactionState }>;
};

export function createAppState(): AppState {
  const draftPersistenceEnabled = isDraftPersistenceEnabled();
  const draft = loadDraft({ ...defaultDraft, acknowledgements: [...defaultDraft.acknowledgements] as [boolean, boolean] }, draftPersistenceEnabled);
  const builderRehearsal = createRehearsal(Math.floor(Date.now() / 1000), draft.inactivityPeriod, draft.gracePeriod);
  const rehearsal = createRehearsal(Math.floor(Date.now() / 1000), DEMO_REHEARSAL.inactivityPeriod, DEMO_REHEARSAL.gracePeriod);
  return {
    rehearsal,
    builderRehearsal,
    draft,
    wallet: { connected: false, connecting: false },
    homeScene: 'choose',
    livePlans: [],
    plansLoading: false,
    planRowDiagnostics: {},
    planRole: 'owner',
    plansQuery: '',
    plansTotal: 0n,
    plansLoadedIds: [],
    plansNextOffset: 0n,
    plansObservedBlock: undefined,
    planRowErrors: {},
    walletBalanceLoading: false,
    walletBalanceVersion: 0,
    createFeeEstimateLoading: false,
    actionFeeEstimateLoading: false,
    storageAvailable: hasLocalStorage(),
    draftPersistenceEnabled,
    transactions: loadTransactions(),
  };
}
