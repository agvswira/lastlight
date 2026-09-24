#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, isAddress, keccak256, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const index = process.argv.indexOf('--network');
const network = index >= 0 ? process.argv[index + 1] : undefined;
if (network !== 'testnet') throw new Error('The guarded lifecycle runner currently accepts only --network testnet.');

const manifestPath = 'deployments/968.json';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.chainId !== 968 || manifest.network !== 'testnet' || !manifest.contractAddress || manifest.verificationStatus !== 'verified') {
  throw new Error(`Lifecycle is blocked: ${manifestPath} must contain an actual verified testnet deployment.`);
}
if (process.env.LIFECYCLE_APPROVED !== 'true') {
  throw new Error('Lifecycle broadcast is guarded. Set LIFECYCLE_APPROVED=true after dedicated accounts, gas, timing, and evidence paths are reviewed.');
}

const keyNames = ['LIFECYCLE_OWNER_KEY', 'LIFECYCLE_SUCCESSOR_KEY', 'LIFECYCLE_SUCCESSOR_2_KEY', 'LIFECYCLE_UNRELATED_KEY'];
const defaultAnvilKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
for (const name of keyNames) {
  const key = process.env[name]?.trim();
  if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) throw new Error(`${name} must be a 32-byte private key supplied outside the repository.`);
  if (key.toLowerCase() === defaultAnvilKey) throw new Error(`${name} uses the default Anvil key; use a dedicated funded test account.`);
}

const owner = privateKeyToAccount(process.env.LIFECYCLE_OWNER_KEY);
const successor = privateKeyToAccount(process.env.LIFECYCLE_SUCCESSOR_KEY);
const successor2 = privateKeyToAccount(process.env.LIFECYCLE_SUCCESSOR_2_KEY);
const unrelated = privateKeyToAccount(process.env.LIFECYCLE_UNRELATED_KEY);
const lifecycleAddresses = [owner.address, successor.address, successor2.address, unrelated.address].map((address) => address.toLowerCase());
if (new Set(lifecycleAddresses).size !== lifecycleAddresses.length) throw new Error('Lifecycle owner, successor, replacement successor, and unrelated accounts must be distinct.');
const amount = process.env.LIFECYCLE_AMOUNT_WEI ? BigInt(process.env.LIFECYCLE_AMOUNT_WEI) : parseEther('0.01');
if (amount <= 0n) throw new Error('LIFECYCLE_AMOUNT_WEI must be positive.');

const contract = manifest.contractAddress;
const sourceBuildHash = manifest.gitCommit ?? manifest.sourceSha256 ?? manifest.runtimeCodeHash ?? 'unknown';
const rpcUrl = process.env.BOT_TESTNET_RPC_URL?.trim() || manifest.rpcUrl;
if (!rpcUrl) throw new Error('Lifecycle requires BOT_TESTNET_RPC_URL or a testnet manifest rpcUrl.');
const chain = defineChain({
  id: 968,
  name: 'BOT Testnet',
  nativeCurrency: { name: 'BOT', symbol: 'BOT', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: 'BOT Explorer', url: manifest.explorerUrl } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
if (await publicClient.getChainId() !== 968) throw new Error(`Lifecycle RPC returned the wrong chain; expected 968 at ${rpcUrl}.`);
const runtimeCode = await publicClient.getBytecode({ address: contract });
if (!runtimeCode || runtimeCode === '0x') throw new Error('Lifecycle is blocked: the manifest address has no runtime bytecode.');
if (manifest.runtimeCodeHash && keccak256(runtimeCode).toLowerCase() !== manifest.runtimeCodeHash.toLowerCase()) {
  throw new Error('Lifecycle is blocked: runtime bytecode does not match the deployment manifest.');
}
const payoutOverride = process.env.LIFECYCLE_PAYOUT?.trim();
if (payoutOverride && !isAddress(payoutOverride)) throw new Error('LIFECYCLE_PAYOUT must be a valid address.');
const payoutAddress = payoutOverride ?? unrelated.address;
if (payoutAddress.toLowerCase() === '0x0000000000000000000000000000000000000000' || payoutAddress.toLowerCase() === contract.toLowerCase()) {
  throw new Error('LIFECYCLE_PAYOUT must be a non-zero address other than the Lastlight contract.');
}

const vaultComponents = [
  { name: 'owner', type: 'address' }, { name: 'successor', type: 'address' }, { name: 'previousSuccessor', type: 'address' }, { name: 'settlementRecipient', type: 'address' },
  { name: 'depositedAmount', type: 'uint256' }, { name: 'amount', type: 'uint256' }, { name: 'createdAt', type: 'uint256' }, { name: 'lastHeartbeat', type: 'uint256' },
  { name: 'inactivityPeriod', type: 'uint256' }, { name: 'gracePeriod', type: 'uint256' }, { name: 'settledAt', type: 'uint256' }, { name: 'createdBlock', type: 'uint256' },
  { name: 'lastHeartbeatBlock', type: 'uint256' }, { name: 'successorChangedBlock', type: 'uint256' }, { name: 'settledBlock', type: 'uint256' }, { name: 'settlement', type: 'uint8' },
];
const abi = [
  { type: 'function', name: 'createVault', stateMutability: 'payable', inputs: [{ name: 'successor', type: 'address' }, { name: 'inactivityPeriod', type: 'uint256' }, { name: 'gracePeriod', type: 'uint256' }], outputs: [{ name: 'vaultId', type: 'uint256' }] },
  { type: 'function', name: 'heartbeat', stateMutability: 'nonpayable', inputs: [{ name: 'vaultId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'changeSuccessor', stateMutability: 'nonpayable', inputs: [{ name: 'vaultId', type: 'uint256' }, { name: 'newSuccessor', type: 'address' }], outputs: [] },
  { type: 'function', name: 'cancelVault', stateMutability: 'nonpayable', inputs: [{ name: 'vaultId', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [{ name: 'vaultId', type: 'uint256' }, { name: 'recipient', type: 'address' }], outputs: [] },
  { type: 'function', name: 'getVaultView', stateMutability: 'view', inputs: [{ name: 'vaultId', type: 'uint256' }], outputs: [{ name: 'view', type: 'tuple', components: [
    { name: 'vault', type: 'tuple', components: vaultComponents }, { name: 'status', type: 'uint8' }, { name: 'checkInBy', type: 'uint256' }, { name: 'claimableAt', type: 'uint256' }, { name: 'observedAt', type: 'uint256' }, { name: 'observedBlock', type: 'uint256' },
  ] }] },
  { type: 'event', name: 'VaultCreated', anonymous: false, inputs: [{ name: 'vaultId', type: 'uint256', indexed: true }, { name: 'owner', type: 'address', indexed: true }, { name: 'successor', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }, { name: 'inactivityPeriod', type: 'uint256', indexed: false }, { name: 'gracePeriod', type: 'uint256', indexed: false }, { name: 'createdAt', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Heartbeat', anonymous: false, inputs: [{ name: 'vaultId', type: 'uint256', indexed: true }, { name: 'owner', type: 'address', indexed: true }, { name: 'previousHeartbeat', type: 'uint256', indexed: false }, { name: 'newHeartbeat', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'SuccessorChanged', anonymous: false, inputs: [{ name: 'vaultId', type: 'uint256', indexed: true }, { name: 'previousSuccessor', type: 'address', indexed: true }, { name: 'newSuccessor', type: 'address', indexed: true }] },
  { type: 'event', name: 'VaultCancelled', anonymous: false, inputs: [{ name: 'vaultId', type: 'uint256', indexed: true }, { name: 'owner', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'VaultClaimed', anonymous: false, inputs: [{ name: 'vaultId', type: 'uint256', indexed: true }, { name: 'successor', type: 'address', indexed: true }, { name: 'recipient', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
];

const runId = process.env.LIFECYCLE_RUN_ID ?? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const evidenceDir = `evidence/testnet/${runId}`;
const journalPath = `${evidenceDir}/journal.json`;
await mkdir(evidenceDir, { recursive: true });

let journal;
try { journal = JSON.parse(await readFile(journalPath, 'utf8')); } catch {
  journal = { schemaVersion: 'lastlight.lifecycle.v1', runId, network, chainId: 968, contract, sourceBuildHash, steps: {}, observations: {}, simulations: {}, scenarios: {} };
}
if (journal.contract !== contract) throw new Error(`Run ${runId} belongs to another deployment.`);

const stringify = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const saveJournal = async () => writeFile(journalPath, stringify(journal));
const safeName = (value) => value.replace(/[^a-zA-Z0-9_-]/g, '-');
const accountFor = (account) => createWalletClient({ account, chain, transport: http(rpcUrl) });
const statusNames = ['ACTIVE', 'GRACE', 'CLAIMABLE', 'CANCELLED', 'CLAIMED'];
const stepResult = (key) => journal.steps[key]?.result;

async function readView(vaultId) {
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  const raw = await publicClient.readContract({ address: contract, abi, functionName: 'getVaultView', args: [vaultId], blockNumber: block.number });
  const view = Array.isArray(raw) ? raw[0] : raw;
  return { view, block };
}

async function readSnapshot(vaultId) {
  if (vaultId === undefined) return undefined;
  try {
    const { view, block } = await readView(vaultId);
    return {
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      blockTimestamp: block.timestamp.toString(),
      status: statusNames[Number(view.status)] ?? 'UNKNOWN',
      checkInBy: view.checkInBy.toString(),
      claimableAt: view.claimableAt.toString(),
      owner: view.vault.owner,
      successor: view.vault.successor,
      amount: view.vault.amount.toString(),
      settlement: Number(view.vault.settlement),
    };
  } catch {
    return undefined;
  }
}

async function recordObservation(label, vaultId) {
  if (journal.observations[label]) {
    await writeFile(`${evidenceDir}/${safeName(label)}.json`, stringify(journal.observations[label]));
    return journal.observations[label];
  }
  const { view, block } = await readView(vaultId);
  const record = {
    kind: 'observation', runId, label, chainId: 968, contract, vaultId: vaultId.toString(), sourceBuildHash,
    blockNumber: block.number.toString(), blockHash: block.hash, blockTimestamp: block.timestamp.toString(), status: statusNames[Number(view.status)] ?? 'UNKNOWN',
    checkInBy: view.checkInBy.toString(), claimableAt: view.claimableAt.toString(), owner: view.vault.owner, successor: view.vault.successor,
    amount: view.vault.amount.toString(), settlement: Number(view.vault.settlement),
  };
  journal.observations[label] = record;
  await writeFile(`${evidenceDir}/${safeName(label)}.json`, stringify(record));
  await saveJournal();
  return record;
}

async function recordSimulation(label, account, functionName, args, vaultId, shouldRevert = true) {
  if (journal.simulations[label]) {
    await writeFile(`${evidenceDir}/${safeName(label)}.json`, stringify(journal.simulations[label]));
    return journal.simulations[label];
  }
  const block = await publicClient.getBlock({ blockTag: 'latest' });
  const calldata = encodeFunctionData({ abi, functionName, args });
  let succeeded = false;
  let errorName;
  let errorMessage;
  try {
    await publicClient.simulateContract({ address: contract, abi, functionName, args, account: account.address, blockNumber: block.number });
    succeeded = true;
  } catch (error) {
    errorName = error?.name ?? error?.shortMessage ?? 'SimulationError';
    errorMessage = String(error?.shortMessage ?? error?.message ?? errorName).slice(0, 300);
  }
  const record = {
    kind: 'simulation', runId, label, chainId: 968, contract, vaultId: vaultId?.toString(), sourceBuildHash,
    caller: account.address, method: functionName, calldata, blockTag: block.number.toString(), blockHash: block.hash,
    outcome: succeeded ? 'unexpected-success' : 'reverted', decodedError: errorName, message: errorMessage,
  };
  journal.simulations[label] = record;
  await writeFile(`${evidenceDir}/${safeName(label)}.json`, stringify(record));
  await saveJournal();
  if (shouldRevert && succeeded) throw new Error(`Expected simulation ${label} to revert, but it succeeded.`);
  return record;
}

async function decodeExpectedEvent(receipt, expectedEvent) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (decoded.eventName === expectedEvent) return decoded.args;
    } catch { /* inspect the next log */ }
  }
  throw new Error(`Receipt ${receipt.transactionHash} did not contain ${expectedEvent}.`);
}

async function saveTransactionEvidence(key, sender, functionName, args, value, expectedEvent, vaultId, receipt, eventArgs, context = {}) {
  const currentBlock = await publicClient.getBlockNumber();
  let transaction;
  try { transaction = await publicClient.getTransaction({ hash: receipt.transactionHash }); } catch { /* nonce is optional when the RPC omits historical tx lookup */ }
  const gasPrice = receipt.effectiveGasPrice ?? transaction?.gasPrice;
  const feeWei = receipt.gasUsed !== undefined && gasPrice !== undefined ? receipt.gasUsed * gasPrice : undefined;
  const record = {
    kind: 'transaction', runId, chainId: 968, contract, vaultId: (eventArgs.vaultId ?? vaultId)?.toString(), sourceBuildHash,
    sender, method: functionName, args, value, hash: receipt.transactionHash, nonce: transaction?.nonce ?? null, receiptStatus: receipt.status, blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash, blockTimestamp: (await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp, confirmations: currentBlock - receipt.blockNumber + 1n,
    gasUsed: receipt.gasUsed ?? null, effectiveGasPrice: gasPrice ?? null, feeWei: feeWei ?? null,
    eventName: expectedEvent, eventArgs, explorerUrl: `${manifest.explorerUrl}/tx/${receipt.transactionHash}`, pre: context.pre ?? null, post: context.post ?? null,
  };
  await writeFile(`${evidenceDir}/${safeName(key)}.json`, stringify(record));
}

async function writeStep(key, actor, functionName, args, value, expectedEvent, vaultId, context = {}) {
  const existing = journal.steps[key];
  if (existing?.status === 'broadcasting' && !existing.hash) throw new Error(`Run ${runId} has an unresolved broadcast for ${key}; reconcile it before retrying.`);
  if (existing?.hash) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: existing.hash });
      if (receipt.status === 'success') {
        const eventArgs = await decodeExpectedEvent(receipt, expectedEvent);
        const post = await readSnapshot(vaultId);
        await saveTransactionEvidence(key, existing.sender, existing.method, existing.args, existing.value, expectedEvent, vaultId, receipt, eventArgs, { ...existing, post: existing.post ?? post });
        return { hash: existing.hash, receipt, eventArgs };
      }
    } catch { /* wait below when the transaction is still pending */ }
    journal.steps[key] = { ...existing, status: 'submitted' };
    await saveJournal();
    const receipt = await publicClient.waitForTransactionReceipt({ hash: existing.hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error(`${key} was included but reverted.`);
    const eventArgs = await decodeExpectedEvent(receipt, expectedEvent);
    const post = await readSnapshot(vaultId);
    journal.steps[key] = { ...journal.steps[key], status: 'confirmed', post, result: { hash: existing.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, eventArgs } };
    await saveJournal();
    await saveTransactionEvidence(key, existing.sender, existing.method, existing.args, existing.value, expectedEvent, vaultId, receipt, eventArgs, { ...journal.steps[key], post });
    return { hash: existing.hash, receipt, eventArgs };
  }

  const calldata = encodeFunctionData({ abi, functionName, args });
  const pre = await readSnapshot(vaultId);
  journal.steps[key] = { status: 'broadcasting', sender: actor.address, method: functionName, args, value, calldata, ...context, pre: context.pre ?? pre };
  await saveJournal();
  const simulation = await publicClient.simulateContract({ address: contract, abi, functionName, args, account: actor.address, value });
  const wallet = accountFor(actor);
  const hash = await wallet.writeContract(simulation.request);
  journal.steps[key] = { ...journal.steps[key], status: 'submitted', hash };
  await saveJournal();
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') throw new Error(`${key} was included but reverted.`);
  const eventArgs = await decodeExpectedEvent(receipt, expectedEvent);
  const post = await readSnapshot(vaultId);
  journal.steps[key] = { ...journal.steps[key], status: 'confirmed', post, result: { hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, eventArgs } };
  await saveJournal();

  await saveTransactionEvidence(key, actor.address, functionName, args, value, expectedEvent, vaultId, receipt, eventArgs, { ...journal.steps[key], post });
  return { hash, receipt, eventArgs };
}

async function waitForStatus(label, vaultId, expectedStatus) {
  const maxSeconds = Number(process.env.LIFECYCLE_MAX_WAIT_SECONDS ?? 900);
  const started = Date.now();
  while ((Date.now() - started) / 1000 < maxSeconds) {
    const record = await recordObservation(`${label}-poll-${Math.floor((Date.now() - started) / 1000)}`, vaultId);
    if (record.status === expectedStatus) return record;
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.LIFECYCLE_POLL_MS ?? 4000)));
  }
  throw new Error(`Timed out waiting for ${label} to reach ${expectedStatus}.`);
}

async function waitPastDeadline(label, vaultId) {
  const maxSeconds = Number(process.env.LIFECYCLE_MAX_WAIT_SECONDS ?? 900);
  const started = Date.now();
  while ((Date.now() - started) / 1000 < maxSeconds) {
    const record = await recordObservation(`${label}-poll-${Math.floor((Date.now() - started) / 1000)}`, vaultId);
    if (BigInt(record.blockTimestamp) >= BigInt(record.claimableAt)) return record;
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.LIFECYCLE_POLL_MS ?? 4000)));
  }
  throw new Error(`Timed out waiting for ${label} to pass the original deadline.`);
}

async function createPlan(scenario, successorAddress) {
  const key = `${scenario}-create`;
  const prior = stepResult(key);
  if (prior?.eventArgs?.vaultId !== undefined) return BigInt(prior.eventArgs.vaultId);
  const result = await writeStep(key, owner, 'createVault', [successorAddress, 60n, 30n], amount, 'VaultCreated', undefined, { scenario });
  return BigInt(result.eventArgs.vaultId);
}

async function runT1() {
  if (journal.scenarios.T1?.status === 'complete') return;
  const vaultId = journal.scenarios.T1?.vaultId ? BigInt(journal.scenarios.T1.vaultId) : await createPlan('T1', successor.address);
  journal.scenarios.T1 = { status: 'in-progress', vaultId: vaultId.toString() };
  await saveJournal();
  await recordObservation('T1-active-after-create', vaultId);
  await recordSimulation('T1-claim-before-deadline', successor, 'claim', [vaultId, successor.address], vaultId);
  await writeStep('T1-heartbeat-before-grace', owner, 'heartbeat', [vaultId], undefined, 'Heartbeat', vaultId, { scenario: 'T1' });
  await writeStep('T1-replace-successor', owner, 'changeSuccessor', [vaultId, successor2.address], undefined, 'SuccessorChanged', vaultId, { scenario: 'T1' });
  await recordObservation('T1-after-replacement', vaultId);
  await recordSimulation('T1-former-successor-before-deadline', successor, 'claim', [vaultId, successor.address], vaultId);
  await waitForStatus('T1-enter-grace', vaultId, 'GRACE');
  await recordSimulation('T1-wrong-caller-in-grace', unrelated, 'heartbeat', [vaultId], vaultId);
  await writeStep('T1-recovery-heartbeat', owner, 'heartbeat', [vaultId], undefined, 'Heartbeat', vaultId, { scenario: 'T1' });
  await recordObservation('T1-recovered-active', vaultId);
  await waitForStatus('T1-claimable', vaultId, 'CLAIMABLE');
  await recordSimulation('T1-owner-after-deadline', owner, 'heartbeat', [vaultId], vaultId);
  await recordSimulation('T1-former-successor-after-deadline', successor, 'claim', [vaultId, successor.address], vaultId);
  await writeStep('T1-claim-by-successor-2', successor2, 'claim', [vaultId, successor2.address], undefined, 'VaultClaimed', vaultId, { scenario: 'T1' });
  await recordSimulation('T1-duplicate-claim', successor2, 'claim', [vaultId, successor2.address], vaultId);
  await recordObservation('T1-claimed', vaultId);
  journal.scenarios.T1 = { status: 'complete', vaultId: vaultId.toString() };
  await saveJournal();
}

async function runT2() {
  if (journal.scenarios.T2?.status === 'complete') return;
  const vaultId = journal.scenarios.T2?.vaultId ? BigInt(journal.scenarios.T2.vaultId) : await createPlan('T2', successor.address);
  journal.scenarios.T2 = { status: 'in-progress', vaultId: vaultId.toString() };
  await saveJournal();
  await recordObservation('T2-active-before-close', vaultId);
  await writeStep('T2-close-active', owner, 'cancelVault', [vaultId, owner.address], undefined, 'VaultCancelled', vaultId, { scenario: 'T2' });
  await recordObservation('T2-closed', vaultId);
  await recordSimulation('T2-claim-after-close', successor, 'claim', [vaultId, successor.address], vaultId);
  await waitPastDeadline('T2-original-deadline', vaultId);
  await recordObservation('T2-terminal-after-original-deadline', vaultId);
  journal.scenarios.T2 = { status: 'complete', vaultId: vaultId.toString() };
  await saveJournal();
}

async function runT3() {
  if (journal.scenarios.T3?.status === 'complete') return;
  const payout = payoutAddress;
  const vaultId = journal.scenarios.T3?.vaultId ? BigInt(journal.scenarios.T3.vaultId) : await createPlan('T3', successor.address);
  journal.scenarios.T3 = { status: 'in-progress', vaultId: vaultId.toString(), payout };
  await saveJournal();
  await waitForStatus('T3-enter-grace', vaultId, 'GRACE');
  await writeStep('T3-close-grace-alternate-payout', owner, 'cancelVault', [vaultId, payout], undefined, 'VaultCancelled', vaultId, { scenario: 'T3', payout });
  await recordObservation('T3-closed-in-grace', vaultId);
  await recordSimulation('T3-claim-after-close', successor, 'claim', [vaultId, successor.address], vaultId);
  await waitPastDeadline('T3-original-deadline', vaultId);
  await recordObservation('T3-terminal-after-original-deadline', vaultId);
  journal.scenarios.T3 = { status: 'complete', vaultId: vaultId.toString(), payout };
  await saveJournal();
}

await runT1();
await runT2();
await runT3();
console.log(`Lifecycle ${runId} completed for ${network} at ${contract}. Evidence: ${evidenceDir}`);
