import type { PlanStatus, RehearsalView } from './types';
import type { Observation } from './types';

export const MIN_INACTIVITY_SECONDS = 60;
export const MAX_INACTIVITY_SECONDS = 365 * 24 * 60 * 60;
export const MIN_GRACE_SECONDS = 30;
export const MAX_GRACE_SECONDS = 30 * 24 * 60 * 60;
export const MAX_OBSERVATION_AGE_MS = 20_000;
export const BASE_READ_POLL_MS = 5_000;
export const MAX_READ_POLL_MS = 30_000;
export const REQUIRED_CONFIRMATIONS = 2n;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getBoundaries(baseTimestamp: number, inactivityPeriod: number, gracePeriod: number) {
  return {
    checkInBy: baseTimestamp + inactivityPeriod,
    claimableAt: baseTimestamp + inactivityPeriod + gracePeriod,
  };
}

export function statusAt(elapsed: number, inactivityPeriod: number, gracePeriod: number): PlanStatus {
  if (elapsed < inactivityPeriod) return 'ACTIVE';
  if (elapsed < inactivityPeriod + gracePeriod) return 'GRACE';
  return 'CLAIMABLE';
}

export function statusLabel(status: PlanStatus): string {
  return {
    ACTIVE: 'On track',
    GRACE: 'Check-in overdue',
    CLAIMABLE: 'Ready to claim',
    CANCELLED: 'Closed by owner',
    CLAIMED: 'Claimed',
  }[status];
}

export function statusKicker(status: PlanStatus): string {
  return {
    ACTIVE: 'Owner control',
    GRACE: 'Extra time',
    CLAIMABLE: 'Recipient access',
    CANCELLED: 'Settled',
    CLAIMED: 'Settled',
  }[status];
}

export function getRehearsalView(baseTimestamp: number, inactivityPeriod: number, gracePeriod: number, previewElapsed: number, extra: Partial<RehearsalView> = {}): RehearsalView {
  const elapsed = clamp(previewElapsed, 0, inactivityPeriod + gracePeriod);
  const boundaries = getBoundaries(baseTimestamp, inactivityPeriod, gracePeriod);
  return {
    source: 'rehearsal',
    baseTimestamp,
    inactivityPeriod,
    gracePeriod,
    previewElapsed: elapsed,
    status: statusAt(elapsed, inactivityPeriod, gracePeriod),
    ...boundaries,
    ...extra,
  };
}

export function getReminderLead(inactivityPeriod: number): number {
  return Math.min(7 * 24 * 60 * 60, Math.max(1, Math.floor(inactivityPeriod / 10)));
}

export function readPollDelayMs(failureCount: number): number {
  const failures = Number.isFinite(failureCount) ? Math.max(0, Math.floor(failureCount)) : 0;
  return Math.min(MAX_READ_POLL_MS, BASE_READ_POLL_MS * 2 ** Math.min(failures, 3));
}

export function hasRequiredConfirmations(confirmations: bigint | undefined): boolean {
  return confirmations !== undefined && confirmations >= REQUIRED_CONFIRMATIONS;
}

export function validatePolicy(inactivityPeriod: number, gracePeriod: number): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(inactivityPeriod) || inactivityPeriod < MIN_INACTIVITY_SECONDS || inactivityPeriod > MAX_INACTIVITY_SECONDS) {
    errors.push(`Check-in interval must be between ${formatDuration(MIN_INACTIVITY_SECONDS)} and ${formatDuration(MAX_INACTIVITY_SECONDS)}.`);
  }
  if (!Number.isInteger(gracePeriod) || gracePeriod < MIN_GRACE_SECONDS || gracePeriod > MAX_GRACE_SECONDS) {
    errors.push(`Extra time must be between ${formatDuration(MIN_GRACE_SECONDS)} and ${formatDuration(MAX_GRACE_SECONDS)}.`);
  }
  return errors;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'Duration unavailable';
  let remaining = Math.max(0, Math.floor(seconds));
  const units: Array<[number, string]> = [[24 * 60 * 60, 'day'], [60 * 60, 'hour'], [60, 'minute'], [1, 'second']];
  const parts: string[] = [];
  for (const [size, label] of units) {
    const count = Math.floor(remaining / size);
    if (count > 0) parts.push(`${count} ${label}${count === 1 ? '' : 's'}`);
    remaining %= size;
  }
  return parts.length ? parts.join(' ') : '0 seconds';
}

export function formatDate(timestamp: number | bigint, includeTime = true, includeSeconds = false): string {
  const milliseconds = Number(timestamp) * 1000;
  if (!Number.isFinite(milliseconds)) return 'Date unavailable';
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    ...(includeTime ? { timeStyle: includeSeconds ? 'medium' as const : 'short' as const } : {}),
  }).format(date);
}

export function formatDateUtc(timestamp: number | bigint, includeSeconds = false): string {
  const date = new Date(Number(timestamp) * 1000);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', dateStyle: 'medium', timeStyle: includeSeconds ? 'medium' as const : 'short' as const, hour12: false,
  }).format(date).replace(',', '') + ' UTC';
}

export function formatRelativeDeadline(timestamp: number | bigint, now = Date.now() / 1000): string {
  const seconds = Number(timestamp) - now;
  if (seconds <= 0) return 'Now available';
  return `in ${formatDuration(Math.ceil(seconds))}`;
}

export function isObservationFresh(observation: Observation | undefined, now = typeof performance === 'undefined' ? 0 : performance.now(), maxAgeMs = MAX_OBSERVATION_AGE_MS): boolean {
  return Boolean(observation && (now === 0 || now - observation.receivedAtMonotonicMs <= maxAgeMs));
}

/**
 * Advances a displayed chain timestamp only from the local monotonic clock,
 * and only for the same freshness window used by live reads. This is a visual
 * estimate; it must never be used to decide authority or enable a write.
 */
export function displayObservedTimestamp(observation: Observation | undefined, fallback: bigint, now = typeof performance === 'undefined' ? 0 : performance.now()): bigint {
  if (!observation) return fallback;
  const elapsedMs = now === 0 ? 0 : Math.min(MAX_OBSERVATION_AGE_MS, Math.max(0, now - observation.receivedAtMonotonicMs));
  return observation.blockTimestamp + BigInt(Math.floor(elapsedMs / 1000));
}
