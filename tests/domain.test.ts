import assert from 'node:assert/strict';
import { test } from 'vitest';
import { amountHasValidPrecision, formatNativeAmount, parseNativeAmount } from '../src/domain/amount.ts';
import { displayObservedTimestamp, formatDuration, getBoundaries, hasRequiredConfirmations, isObservationFresh, readPollDelayMs, statusAt, validatePolicy } from '../src/domain/policy.ts';
import { createRehearsal, reduceRehearsal } from '../src/domain/rehearsal.ts';
import { hasBadMixedChecksum, isAddress, isZeroAddress } from '../src/domain/address.ts';
import { buildRecipientIcs, buildReminderIcs } from '../src/exports/calendar.ts';
import { handoffHtml, handoffText, handoffVerification } from '../src/exports/handoff.ts';
import { buildReceiptPayload } from '../src/exports/receipt.ts';
import { parseRoute } from '../src/app/router.ts';
import { createAppState, defaultDraft } from '../src/app/state.ts';
import { DEMO_PLAN, DEMO_REHEARSAL } from '../src/app/demo-data.ts';
import { hasLocalStorage, isDraftPersistenceEnabled, loadDraft, loadTransactions, saveDraft, saveTransaction, setDraftPersistenceEnabled } from '../src/storage/local.ts';
import { generatedAbiSha256 } from '../src/chain/abi.ts';
import { manifests, type DeploymentManifest } from '../src/app/config.ts';
import { formatDeploymentDate, renderLaunch } from '../src/pages/launch.ts';
import { renderProof } from '../src/pages/proof.ts';
import { planCard } from '../src/pages/shared.ts';
import { sortPlansForRole } from '../src/pages/plans.ts';
import { diagnosticDetails, sanitizeDiagnostic } from '../src/components/ui.ts';

test('policy boundaries are exact and statuses do not overlap', () => {
  const boundaries = getBoundaries(100, 60, 30);
  assert.deepEqual(boundaries, { checkInBy: 160, claimableAt: 190 });
  assert.equal(statusAt(59, 60, 30), 'ACTIVE');
  assert.equal(statusAt(60, 60, 30), 'GRACE');
  assert.equal(statusAt(89, 60, 30), 'GRACE');
  assert.equal(statusAt(90, 60, 30), 'CLAIMABLE');
});

test('rehearsal is a pure state transition with no transaction fields', () => {
  const initial = createRehearsal(100, 60, 30);
  const grace = reduceRehearsal(initial, 'miss-check-in');
  assert.equal(grace.status, 'GRACE');
  const recovered = reduceRehearsal(grace, 'return-during-grace');
  assert.equal(recovered.status, 'ACTIVE');
  assert.equal(recovered.previewElapsed, 0);
  const claimable = reduceRehearsal(recovered, 'let-deadline-pass');
  assert.equal(claimable.status, 'CLAIMABLE');
  assert.equal('hash' in claimable, false);
  assert.equal('account' in claimable, false);
});

test('rehearsal return works at D-1 and stays closed at D', () => {
  const initial = createRehearsal(100, 60, 30);
  const beforeDeadline = reduceRehearsal(
    reduceRehearsal(initial, { type: 'set-preview', elapsed: 89 }),
    'return-during-grace',
  );
  assert.equal(beforeDeadline.status, 'ACTIVE');
  assert.equal(beforeDeadline.previewElapsed, 0);
  assert.equal(beforeDeadline.returnFrom, 89);
  assert.equal(beforeDeadline.returnTo, 0);

  const atDeadline = reduceRehearsal(
    reduceRehearsal(initial, { type: 'set-preview', elapsed: 90 }),
    'return-during-grace',
  );
  assert.equal(atDeadline.status, 'CLAIMABLE');
  assert.equal(atDeadline.previewElapsed, 90);
  assert.equal(atDeadline.returnFrom, 90);
  assert.equal(atDeadline.returnTo, 90);
});

test('interactive demo uses the explicit short rehearsal timing', () => {
  assert.equal(DEMO_REHEARSAL.inactivityPeriod, 180);
  assert.equal(DEMO_REHEARSAL.gracePeriod, 180);
  assert.equal(DEMO_REHEARSAL.inactivityPeriod + DEMO_REHEARSAL.gracePeriod, 360);
});

test('read polling backs off after RPC failures without exceeding thirty seconds', () => {
  assert.deepEqual([0, 1, 2, 3, 8].map(readPollDelayMs), [5_000, 10_000, 20_000, 30_000, 30_000]);
});

test('technical diagnostics are escaped, bounded, and redact labeled secrets', () => {
  const detail = diagnosticDetails(new Error('RPC failed <script> privateKey=do-not-show'));
  assert.match(detail, /<details class="diagnostic-details">/);
  assert.match(detail, /&lt;script&gt;/);
  assert.match(detail, /privateKey: \[redacted\]/);
  assert.equal(detail.includes('do-not-show'), false);
  assert.ok(sanitizeDiagnostic('x'.repeat(700)).length <= 600);
});

test('confirmed receipts require two observed confirmations', () => {
  assert.equal(hasRequiredConfirmations(undefined), false);
  assert.equal(hasRequiredConfirmations(1n), false);
  assert.equal(hasRequiredConfirmations(2n), true);
  assert.equal(hasRequiredConfirmations(4n), true);
});

test('released launch record includes dated deployment, proof links, scope, and limits', () => {
  const liveManifest = {
    ...manifests[677],
    contractAddress: '0x4444444444444444444444444444444444444444',
    deploymentTx: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    deploymentTimestamp: '2026-09-22T01:34:55.000Z',
    verifiedSourceUrl: 'https://scan.botchain.ai/address/0x4444444444444444444444444444444444444444#code',
    mainnetWritesEnabled: true,
    smokeTestStatus: 'passed',
    verificationStatus: 'verified',
  } satisfies DeploymentManifest;
  const markup = renderLaunch(liveManifest);
  assert.match(markup, /Lastlight is officially launched on BOT Chain Mainnet/);
  assert.match(markup, /September 22, 2026/);
  assert.match(markup, /Deployment transaction/);
  assert.match(markup, /read-only mainnet checks passed/);
  assert.match(markup, /funded create-to-claim path succeeded on testnet/);
  assert.match(markup, /Verified source/);
  assert.equal(formatDeploymentDate(null), 'Unavailable');
});

test('proof keeps the last observation visible with an actionable refresh issue', () => {
  const markup = renderProof(DEMO_PLAN, { message: 'The last observation is still visible.', diagnostic: 'historical block unavailable' });
  assert.match(markup, /Latest proof read needs a retry/);
  assert.match(markup, /data-refresh-live/);
  assert.match(markup, /Technical details/);
  assert.match(markup, /Current plan state/);
});

test('my plans sort priorities by role and label an unknown incoming plan', () => {
  const plan = (vaultId: bigint, status: 'ACTIVE' | 'GRACE' | 'CLAIMABLE', claimableAt: bigint) => ({
    ...DEMO_PLAN,
    vaultId,
    status,
    checkInBy: claimableAt - 1n,
    claimableAt,
    source: 'chain' as const,
    label: undefined,
    recordedLabel: undefined,
  });
  const plans = [plan(2n, 'ACTIVE', 300n), plan(1n, 'GRACE', 500n), plan(3n, 'CLAIMABLE', 100n), plan(4n, 'GRACE', 200n)];
  assert.deepEqual(sortPlansForRole(plans, 'owner').map(({ vaultId }) => vaultId), [4n, 1n, 2n, 3n]);
  assert.deepEqual(sortPlansForRole(plans, 'successor').map(({ vaultId }) => vaultId), [3n, 4n, 2n, 1n]);
  assert.ok(planCard(plan(9n, 'CLAIMABLE', 100n), '#/plan/968/contract/9', '', `Created by ${DEMO_PLAN.owner}`).includes(`Created by ${DEMO_PLAN.owner}`));
});

test('generated ABI hash matches the exact release artifact identity', async () => {
  assert.equal(await generatedAbiSha256(), '5384a5d8aa8a6d0cbfa50f8302306bb5421b9bf54d3526c6931d5302b62e61de');
});

test('native amount parser rejects ambiguity and preserves 18 decimals', () => {
  assert.equal(parseNativeAmount('0.01'), 10_000_000_000_000_000n);
  assert.equal(parseNativeAmount('1.000000000000000001'), 1_000_000_000_000_000_001n);
  assert.equal(parseNativeAmount('1e-3'), null);
  assert.equal(parseNativeAmount('1.0000000000000000001'), null);
  assert.equal(amountHasValidPrecision('0.01'), true);
  assert.equal(amountHasValidPrecision(''), false);
});

test('native amount display does not turn tiny nonzero values into zero', () => {
  assert.equal(formatNativeAmount(1n), '<0.0001 BOT');
  assert.equal(formatNativeAmount(1_000_000_000_000_000_001n), '1.0000… BOT');
  assert.equal(formatNativeAmount(1_000_000_000_000_000_001n, 18), '1.000000000000000001 BOT');
});

test('address guard distinguishes valid, zero, and malformed values', () => {
  const address = '0x1111111111111111111111111111111111111111';
  assert.equal(isAddress(address), true);
  assert.equal(isZeroAddress(address), false);
  assert.equal(isZeroAddress('0x0000000000000000000000000000000000000000'), true);
  assert.equal(isAddress('0x123'), false);
  assert.equal(hasBadMixedChecksum('0x1111111111111111111111111111111111111111'), false);
  assert.equal(hasBadMixedChecksum('0x52908400098527886e0F7030069857D2E4169EE7'), true);
  assert.equal(hasBadMixedChecksum('0x52908400098527886E0F7030069857D2E4169EE7'), false);
});

test('policy bounds reject short and oversized windows', () => {
  assert.equal(validatePolicy(60, 30).length, 0);
  assert.equal(validatePolicy(59, 30).length, 1);
  assert.equal(validatePolicy(60, 30 * 24 * 60 * 60 + 1).length, 1);
});

test('duration copy preserves custom timing remainders', () => {
  assert.equal(formatDuration(90), '1 minute 30 seconds');
  assert.equal(formatDuration(3661), '1 hour 1 minute 1 second');
  assert.equal(formatDuration(0), '0 seconds');
});

test('chain observation freshness freezes after the twenty second window', () => {
  const observation = { blockNumber: 12n, blockHash: '0x' as `0x${string}`, blockTimestamp: 100n, receivedAtMonotonicMs: 1_000 };
  assert.equal(isObservationFresh(observation, 20_999), true);
  assert.equal(isObservationFresh(observation, 21_000), true);
  assert.equal(isObservationFresh(observation, 21_001), false);
  assert.equal(isObservationFresh(undefined, 1_000), false);
});

test('displayed chain time advances monotonically and freezes with stale data', () => {
  const observation = { blockNumber: 12n, blockHash: '0x' as `0x${string}`, blockTimestamp: 100n, receivedAtMonotonicMs: 1_000 };
  assert.equal(displayObservedTimestamp(observation, 100n, 6_500), 105n);
  assert.equal(displayObservedTimestamp(observation, 100n, 30_000), 120n);
  assert.equal(displayObservedTimestamp(undefined, 77n, 30_000), 77n);
});

test('calendar export is local, UTC, escaped, and uses a stable UID', () => {
  (globalThis as any).window = { location: { origin: 'https://example.test', pathname: '/' } };
  const ics = buildReminderIcs({
    chainId: 968,
    contract: '0x1111111111111111111111111111111111111111',
    vaultId: 7n,
    owner: '0x2222222222222222222222222222222222222222',
    lastHeartbeat: 1_700_000_000n,
    inactivityPeriod: 90n * 24n * 60n * 60n,
    claimableAt: 1_700_000_000n + 120n * 24n * 60n * 60n,
  }, 3);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.equal(ics.endsWith('\r\n'), true);
  assert.match(unfolded, /UID:lastlight-968-0x1111111111111111111111111111111111111111-7-owner-reminder@lastlight/);
  assert.match(ics, /SEQUENCE:3/);
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);
  assert.match(unfolded, /Check-in by: .*\d{2}:\d{2}:\d{2} UTC/);
  assert.match(unfolded, /Final deadline: .*\d{2}:\d{2}:\d{2} UTC/);
  assert.equal(ics.includes('https://example.test/'), true);
});

test('calendar revision follows the supplied block-derived sequence', () => {
  const ics = buildReminderIcs({
    chainId: 968,
    contract: '0x1111111111111111111111111111111111111111',
    vaultId: 7n,
    owner: '0x2222222222222222222222222222222222222222',
    lastHeartbeat: 1_700_000_000n,
    inactivityPeriod: 90n * 24n * 60n * 60n,
    claimableAt: 1_700_000_000n + 120n * 24n * 60n * 60n,
  }, 1842);
  assert.match(ics, /SEQUENCE:1842/);
});

test('calendar export accepts a future local reminder override without changing its UID', () => {
  const plan = {
    chainId: 968 as const,
    contract: '0x1111111111111111111111111111111111111111' as `0x${string}`,
    vaultId: 7n,
    owner: '0x2222222222222222222222222222222222222222' as `0x${string}`,
    lastHeartbeat: 1_700_000_000n,
    inactivityPeriod: 90n * 24n * 60n * 60n,
    claimableAt: 1_700_000_000n + 120n * 24n * 60n * 60n,
  };
  const original = buildReminderIcs(plan, 3);
  const overridden = buildReminderIcs(plan, 4, 1_700_000_123);
  const uid = /UID:([^\r\n]+)/.exec(original)?.[1];
  assert.equal(uid, /UID:([^\r\n]+)/.exec(overridden)?.[1]);
  const expected = new Date(1_700_000_123 * 1000).toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z');
  assert.match(overridden, new RegExp(`DTSTART:${expected}`));
  assert.match(overridden, /SEQUENCE:4/);
});

test('recipient calendar export keeps a moving-deadline caveat, revision, and stable locator', () => {
  const ics = buildRecipientIcs({
    chainId: 968,
    contract: '0x1111111111111111111111111111111111111111',
    vaultId: 7n,
    successor: '0x3333333333333333333333333333333333333333',
    claimableAt: 1_700_000_090n,
  }, 1842);
  const unfolded = ics.replace(/\r\n /g, '');
  assert.equal(ics.endsWith('\r\n'), true);
  assert.match(unfolded, /UID:lastlight-968-0x1111111111111111111111111111111111111111-7-recipient@lastlight/);
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);
  assert.match(ics, /SEQUENCE:1842/);
  assert.match(unfolded, /The date can move if the owner checks in/);
  assert.equal(unfolded.includes('https://example.test/'), true);
});

test('handoff exports include source identity and escape untrusted addresses', () => {
  const originalOrigin = (globalThis as any).window;
  (globalThis as any).window = { location: { origin: 'https://example.test', pathname: '/' } };
  const plan = {
    chainId: 968 as const,
    contract: '0x1111111111111111111111111111111111111111' as `0x${string}`,
    vaultId: 7n,
    owner: '0x2222222222222222222222222222222222222222' as `0x${string}`,
    successor: '0x3333333333333333333333333333333333333333' as `0x${string}`,
    depositedAmount: 1_000_000_000_000_000n,
    inactivityPeriod: 60n,
    gracePeriod: 30n,
    lastHeartbeat: 1_700_000_000n,
    claimableAt: 1_700_000_090n,
  };
  const text = handoffText(plan);
  const html = handoffHtml({ ...plan, contract: '<script>alert(1)</script>' as `0x${string}` });
  assert.match(text, /Runtime code hash:/);
  assert.match(text, /Source \/ code: No source verification URL attached to this snapshot/);
  assert.match(text, /Current final deadline snapshot: .*\d{2}:\d{2}:\d{2} UTC/);
  assert.match(html, /Final deadline snapshot<\/dt><dd>[^<]*\d{1,2}:\d{2}:\d{2}/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('https://scan.bohr.life/address/0x1111111111111111111111111111111111111111'), false);
  assert.match(html, /ABI hash/);
  (globalThis as any).window = originalOrigin;
});

test('handoff verification never attaches deployment proof to a different contract locator', () => {
  const deployment = {
    ...manifests[968],
    contractAddress: '0x4444444444444444444444444444444444444444',
    verifiedSourceUrl: 'https://scan.bohr.life/address/0x4444444444444444444444444444444444444444#code',
    verificationStatus: 'verified',
  } satisfies DeploymentManifest;
  const mismatch = handoffVerification({ chainId: 968, contract: '0x1111111111111111111111111111111111111111' }, deployment);
  assert.deepEqual(mismatch, { explorerUrl: null, sourceUrl: null, runtimeCodeHash: null, abiSha256: null, verificationStatus: 'unavailable' });
  const match = handoffVerification({ chainId: 968, contract: deployment.contractAddress }, deployment);
  assert.equal(match.explorerUrl, 'https://scan.bohr.life/address/0x4444444444444444444444444444444444444444');
  assert.equal(match.sourceUrl, deployment.verifiedSourceUrl);
  assert.equal(match.verificationStatus, 'verified');
});

test('receipt export normalizes known chain evidence and never invents a hash', () => {
  const payload = buildReceiptPayload({
    chainId: 968,
    contract: '0x1111111111111111111111111111111111111111',
    vaultId: 7n,
    owner: '0x2222222222222222222222222222222222222222',
    successor: '0x3333333333333333333333333333333333333333',
    depositedAmount: 1_000_000_000_000_000n,
    amount: 1_000_000_000_000_000n,
    createdAt: 1_700_000_000n,
    lastHeartbeat: 1_700_000_000n,
    inactivityPeriod: 60n,
    gracePeriod: 30n,
    checkInBy: 1_700_000_060n,
    claimableAt: 1_700_000_090n,
    settlement: 'NONE',
    status: 'ACTIVE',
    source: 'chain',
    transactions: [{
      action: 'create',
      hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      blockNumber: '12',
      blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      confirmations: '2',
      receiptStatus: 'success',
      eventName: 'VaultCreated',
      gasUsed: '21000',
      effectiveGasPrice: '100',
      feeWei: '2100000',
    }],
  }, { note: 'Current chain state plus locally validated receipt.' });
  assert.equal(payload.schemaVersion, 'lastlight.receipt.v1');
  assert.equal(payload.transactionHash, null);
  assert.equal((payload.transactions as Array<Record<string, unknown>>)[0].explorerUrl, 'https://scan.bohr.life/tx/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal((payload.transactions as Array<Record<string, unknown>>)[0].feeWei, '2100000');
  assert.equal(payload.note, 'Current chain state plus locally validated receipt.');
});

test('hash routes keep the deployment locator on plan, recipient, and proof views', () => {
  const contract = '0x1111111111111111111111111111111111111111';
  for (const name of ['plan', 'receive', 'proof'] as const) {
    const route = parseRoute(`#/${name}/968/${contract}/7`);
    assert.equal(route.name, name);
    assert.equal(route.chainId, 968);
    assert.equal(route.contract, contract);
    assert.equal(route.vaultId, 7n);
  }
  assert.equal(parseRoute('#/plan/968/0xabc/0').name, 'not-found');
  assert.equal(parseRoute('#/plan/968/address/7').name, 'not-found');
  assert.equal(parseRoute('#/plan/968/address/not-an-id').name, 'not-found');
});

test('plans route preserves an explicit deployment query', () => {
  assert.deepEqual(parseRoute('#/plans?chain=677'), { name: 'plans', chainId: 677 });
  assert.deepEqual(parseRoute('#/plans?chain=31337'), { name: 'plans', chainId: 31337 });
  assert.equal(parseRoute('#/plans?chain=999').name, 'not-found');
  assert.equal(parseRoute('#/plans?chain=abc').name, 'not-found');
});

test('app state clones draft acknowledgements before local mutation', () => {
  const state = createAppState();
  state.draft.amount = '2';
  state.draft.acknowledgements[0] = true;
  assert.equal(defaultDraft.amount, '0.01');
  assert.deepEqual(defaultDraft.acknowledgements, [false, false]);
});

test('app state derives demo boundaries from its current base timestamp', () => {
  const state = createAppState();
  assert.equal(state.rehearsal.checkInBy, state.rehearsal.baseTimestamp + state.rehearsal.inactivityPeriod);
  assert.equal(state.rehearsal.claimableAt, state.rehearsal.checkInBy + state.rehearsal.gracePeriod);
});

test('local storage denial keeps the core draft path optional', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('storage denied'); } });
    assert.equal(hasLocalStorage(), false);
    assert.equal(saveDraft(defaultDraft), false);
    assert.deepEqual(loadDraft(defaultDraft), defaultDraft);
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    else delete (globalThis as any).localStorage;
  }
});

test('draft persistence is opt-in and removes the saved copy when disabled', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const fakeStorage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as unknown as Storage;
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fakeStorage });
    const fallback = { ...defaultDraft, acknowledgements: [...defaultDraft.acknowledgements] as [boolean, boolean] };
    const saved = { ...fallback, recipient: '0x1111111111111111111111111111111111111111' };
    assert.equal(isDraftPersistenceEnabled(), false);
    assert.deepEqual(loadDraft(fallback), fallback);
    assert.equal(saveDraft(saved), true);
    assert.deepEqual(loadDraft(fallback), fallback);
    assert.equal(setDraftPersistenceEnabled(true), true);
    assert.equal(saveDraft(saved, true), true);
    assert.equal(loadDraft(fallback).recipient, saved.recipient);
    assert.equal(setDraftPersistenceEnabled(false), true);
    assert.equal(isDraftPersistenceEnabled(), false);
    assert.deepEqual(loadDraft(fallback), fallback);
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    else delete (globalThis as any).localStorage;
  }
});

test('transaction journal round-trips serialized status and orders newest first', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const fakeStorage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  } as unknown as Storage;
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fakeStorage });
    assert.equal(saveTransaction('create:intent', {
      status: 'confirming', action: 'create', chainId: 968, contract: '0x1111111111111111111111111111111111111111', account: '0x2222222222222222222222222222222222222222',
      hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', nonce: '7', updatedAt: '2026-09-22T00:00:00.000Z',
    }), true);
    assert.equal(saveTransaction('claim:intent', {
      status: 'rejected', action: 'claim', chainId: 968, contract: '0x1111111111111111111111111111111111111111', account: '0x3333333333333333333333333333333333333333',
      message: 'Cancelled in your wallet.', updatedAt: '2026-09-22T00:01:00.000Z',
    }), true);
    const journal = loadTransactions();
    assert.deepEqual(journal.map(({ key }) => key), ['claim:intent', 'create:intent']);
    assert.equal(journal[1].transaction.hash, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(journal[1].transaction.nonce, '7');
    assert.equal(journal[0].transaction.message, 'Cancelled in your wallet.');
  } finally {
    if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    else delete (globalThis as any).localStorage;
  }
});
