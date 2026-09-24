import type { DurationUnit, PlanDraft, TransactionState } from '../domain/types';

const PREFIX = 'lastlight:v1:';
const DRAFT_PERSISTENCE_KEY = `${PREFIX}draft-persistence`;

function safeStorage(): Storage | null {
  try {
    const key = `${PREFIX}probe`;
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return localStorage;
  } catch {
    return null;
  }
}

export function hasLocalStorage(): boolean {
  return safeStorage() !== null;
}

export function isDraftPersistenceEnabled(): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try { return storage.getItem(DRAFT_PERSISTENCE_KEY) === 'enabled'; } catch { return false; }
}

export function setDraftPersistenceEnabled(enabled: boolean): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    if (enabled) storage.setItem(DRAFT_PERSISTENCE_KEY, 'enabled');
    else {
      storage.removeItem(DRAFT_PERSISTENCE_KEY);
      storage.removeItem(`${PREFIX}draft`);
    }
    return true;
  } catch { return false; }
}

export function loadDraft(fallback: PlanDraft, enabled = isDraftPersistenceEnabled()): PlanDraft {
  if (!enabled) return fallback;
  const storage = safeStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(`${PREFIX}draft`);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<PlanDraft>;
    return {
      ...fallback,
      recipient: typeof value.recipient === 'string' ? value.recipient.slice(0, 128) : fallback.recipient,
      label: typeof value.label === 'string' ? value.label.slice(0, 60) : fallback.label,
      inactivityPeriod: typeof value.inactivityPeriod === 'number' && Number.isFinite(value.inactivityPeriod) ? value.inactivityPeriod : fallback.inactivityPeriod,
      gracePeriod: typeof value.gracePeriod === 'number' && Number.isFinite(value.gracePeriod) ? value.gracePeriod : fallback.gracePeriod,
      inactivityUnit: isDurationUnit(value.inactivityUnit) ? value.inactivityUnit : fallback.inactivityUnit,
      graceUnit: isDurationUnit(value.graceUnit) ? value.graceUnit : fallback.graceUnit,
      inactivityCustom: Boolean(value.inactivityCustom),
      graceCustom: Boolean(value.graceCustom),
      amount: typeof value.amount === 'string' ? value.amount.slice(0, 80) : fallback.amount,
      acknowledgements: Array.isArray(value.acknowledgements) && value.acknowledgements.length === 2
        ? [Boolean(value.acknowledgements[0]), Boolean(value.acknowledgements[1])]
        : fallback.acknowledgements,
      shortTimingAcknowledgement: Boolean(value.shortTimingAcknowledgement),
      step: typeof value.step === 'number' && Number.isInteger(value.step) && value.step >= 0 && value.step <= 3 ? value.step as PlanDraft['step'] : fallback.step,
    };
  } catch {
    return fallback;
  }
}

function isDurationUnit(value: unknown): value is DurationUnit {
  return value === 'seconds' || value === 'minutes' || value === 'hours' || value === 'days';
}

export function saveDraft(draft: PlanDraft, enabled = isDraftPersistenceEnabled()): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    if (!enabled) {
      storage.removeItem(`${PREFIX}draft`);
      return true;
    }
    storage.setItem(`${PREFIX}draft`, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(): void {
  try { safeStorage()?.removeItem(`${PREFIX}draft`); } catch { /* local storage is optional */ }
}

export function saveLabel(chainId: number, contract: string, vaultId: string, label: string): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    storage.setItem(`${PREFIX}label:${chainId}:${contract.toLowerCase()}:${vaultId}`, label.slice(0, 60));
    return true;
  } catch { return false; }
}

export function loadLabel(chainId: number, contract: string, vaultId: string): string | undefined {
  try { return safeStorage()?.getItem(`${PREFIX}label:${chainId}:${contract.toLowerCase()}:${vaultId}`) ?? undefined; } catch { return undefined; }
}

export function saveTransaction(key: string, transaction: TransactionState): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try { storage.setItem(`${PREFIX}tx:${key}`, JSON.stringify(transaction)); return true; } catch { return false; }
}

export function loadTransactions(): Array<{ key: string; transaction: TransactionState }> {
  const storage = safeStorage();
  if (!storage) return [];
  const transactions: Array<{ key: string; transaction: TransactionState }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(`${PREFIX}tx:`)) continue;
    try {
      const transaction = JSON.parse(storage.getItem(key) ?? '') as TransactionState;
      if (transaction && typeof transaction.status === 'string') transactions.push({ key: key.slice(`${PREFIX}tx:`.length), transaction });
    } catch { /* ignore one corrupted local journal entry */ }
  }
  return transactions.sort((a, b) => (b.transaction.updatedAt ?? '').localeCompare(a.transaction.updatedAt ?? ''));
}

export function clearLocalData(): void {
  const storage = safeStorage();
  if (!storage) return;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key?.startsWith(PREFIX)) storage.removeItem(key);
  }
}
