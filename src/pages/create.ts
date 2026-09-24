import { button, diagnosticDetails, escapeHtml, fieldLabel, icon, statusPill } from '../components/ui';
import { formatDate, formatDuration, isObservationFresh, validatePolicy } from '../domain/policy';
import { amountHasValidPrecision, formatNativeAmount, parseNativeAmount } from '../domain/amount';
import { hasBadMixedChecksum, isAddress, isZeroAddress } from '../domain/address';
import type { AppState } from '../app/state';
import { chains, DEFAULT_CHAIN, isSupportedChain, manifests } from '../app/config';
import type { ChainId, DurationUnit } from '../domain/types';
import { inlineNotice } from './shared';

function selectedChainId(state: AppState): ChainId {
  return isSupportedChain(state.wallet.chainId) ? state.wallet.chainId : DEFAULT_CHAIN;
}

export function createIntentKey(state: AppState, chainId: ChainId): string | null {
  const recipient = state.draft.recipient.trim().toLowerCase();
  const amount = parseNativeAmount(state.draft.amount);
  if (!state.wallet.account || !isAddress(recipient) || !amount) return null;
  const contract = manifests[chainId].contractAddress?.toLowerCase() ?? 'unconfigured';
  return `create:${chainId}:${contract}:${state.wallet.account.toLowerCase()}:${recipient}:${amount.toString()}:${state.draft.inactivityPeriod}:${state.draft.gracePeriod}`;
}

function estimatedFeeText(state: AppState, chainId: ChainId): string {
  const intentKey = createIntentKey(state, chainId);
  if (!state.wallet.connected || !state.wallet.account) return 'Connect wallet to estimate';
  if (!intentKey) return 'Complete amount and recipient first';
  if (state.createFeeEstimate?.intentKey === intentKey) return `${formatNativeAmount(BigInt(state.createFeeEstimate.feeWei))} · ${state.createFeeEstimate.gasLimit} gas`;
  if (state.createFeeEstimateLoading) return 'Estimating from the selected RPC…';
  if (state.createFeeEstimateError) return 'Unavailable · checked again before signing';
  return 'Preparing estimate…';
}

function isLastlightContract(value: string, chainId: ChainId): boolean {
  const configured = manifests[chainId].contractAddress;
  return Boolean(configured && value.toLowerCase() === configured.toLowerCase());
}

function unitMultiplier(unit: DurationUnit): number {
  return unit === 'seconds' ? 1 : unit === 'minutes' ? 60 : unit === 'hours' ? 3600 : 86400;
}

function customUnit(state: AppState, field: 'inactivity' | 'grace'): DurationUnit {
  return state.draft[field === 'inactivity' ? 'inactivityUnit' : 'graceUnit'] ?? 'days';
}

function requiresShortTimingAcknowledgement(chainId: ChainId, state: AppState): boolean {
  return chainId === 677 && (state.draft.inactivityPeriod < 30 * 24 * 60 * 60 || state.draft.gracePeriod < 7 * 24 * 60 * 60);
}

function draftErrors(state: AppState, chainId: ChainId): string[] {
  const draft = state.draft;
  const errors = [...validatePolicy(draft.inactivityPeriod, draft.gracePeriod)];
  if (!isAddress(draft.recipient)) errors.push('Enter a valid 0x recipient address.');
  else if (hasBadMixedChecksum(draft.recipient)) errors.push('This mixed-case address has an invalid checksum.');
  else if (isZeroAddress(draft.recipient)) errors.push('The zero address cannot receive a plan.');
  else if (isLastlightContract(draft.recipient, chainId)) errors.push('The Lastlight contract cannot be the named recipient.');
  else if (state.wallet.account && draft.recipient.toLowerCase() === state.wallet.account.toLowerCase()) errors.push('The recipient must be different from the connected owner.');
  if (!amountHasValidPrecision(draft.amount) || parseNativeAmount(draft.amount) === 0n) errors.push('Enter a positive BOT amount with up to 18 decimal places.');
  if (draft.label.length > 60) errors.push('Local plan label must be 60 characters or fewer.');
  return errors;
}

function stepComplete(state: AppState, step: number, chainId: ChainId): boolean {
  const draft = state.draft;
  if (step === 0) return isAddress(draft.recipient) && !hasBadMixedChecksum(draft.recipient) && !isZeroAddress(draft.recipient) && !isLastlightContract(draft.recipient, chainId) && (!state.wallet.account || draft.recipient.toLowerCase() !== state.wallet.account.toLowerCase());
  if (step === 1) return validatePolicy(draft.inactivityPeriod, draft.gracePeriod).length === 0;
  if (step === 2) return amountHasValidPrecision(draft.amount) && parseNativeAmount(draft.amount) !== 0n;
  return draft.acknowledgements.every(Boolean) && (!requiresShortTimingAcknowledgement(chainId, state) || draft.shortTimingAcknowledgement === true) && draftErrors(state, chainId).length === 0;
}

function fieldError(state: AppState, step: number, chainId: ChainId): string {
  if (state.createValidationAttemptedStep !== step) return '';
  if (state.draft.step < step) return '';
  if (step === 0 || step === 2) return '';
  const errors = draftErrors(state, chainId);
  if (step === 1) return errors.find((error) => error.includes('interval') || error.includes('time')) ?? '';
  return errors.length ? 'Review the highlighted items before creating a plan.' : '';
}

function draftSchedule(state: AppState, chainId: ChainId): { checkInBy?: number; claimableAt?: number } {
  const observation = state.createChainObservation?.chainId === chainId && isObservationFresh(state.createChainObservation) ? state.createChainObservation : undefined;
  if (!observation) return {};
  const checkInBy = Number(observation.blockTimestamp) + state.draft.inactivityPeriod;
  return { checkInBy, claimableAt: checkInBy + state.draft.gracePeriod };
}

function scheduleText(value: number | undefined): string {
  return value === undefined ? 'Unavailable until wallet is connected' : formatDate(value, true, true);
}

export function renderCreate(state: AppState): string {
  const draft = state.draft;
  const chainId = selectedChainId(state);
  const chain = chains[chainId];
  const errors = draftErrors(state, chainId);
  const stepLabels = ['Recipient', 'Schedule', 'Amount', 'Review'];
  const owner = state.wallet.account ?? 'Connect wallet before review';
  const shortTimingRequired = requiresShortTimingAcknowledgement(chainId, state);
  const reviewReady = draft.step === 3 && errors.length === 0 && draft.acknowledgements.every(Boolean) && (!shortTimingRequired || draft.shortTimingAcknowledgement === true);
  return `<div class="create-page">
    <section class="product-hero"><div class="shell-width product-hero__inner"><div class="product-hero__copy"><h1>Create plan</h1><p class="lede">Choose a recipient, check-in schedule, and amount.</p></div><img class="product-hero__art" src="./assets/lastlight-hero.webp" alt="" aria-hidden="true"></div></section>
    <section class="shell-width builder-layout"><div class="builder-form">
      ${state.wallet.connected && state.wallet.chainId === 677 && !manifests[677].contractAddress ? `<div class="network-switch-notice">${inlineNotice('Your wallet is on BOT Mainnet', 'Lastlight is deployed on BOT Testnet. Switch your wallet to Testnet before funding a test plan.', 'warning')}${button('Switch to BOT Testnet', { variant: 'secondary', className: 'js-switch-testnet', icon: 'arrow' })}</div>` : ''}
      <ol class="stepper" aria-label="Create plan steps">${stepLabels.map((label, index) => `<li class="stepper__item ${draft.step === index ? 'is-current' : ''} ${index < draft.step && stepComplete(state, index, chainId) ? 'is-complete' : ''}"${draft.step === index ? ' aria-current="step"' : ''}><button type="button" data-create-step="${index}"><span>${index + 1}</span><strong>${label}</strong></button></li>`).join('')}</ol>
      ${draft.step === 0 ? renderRecipientStep(state, owner) : ''}${draft.step === 1 ? renderTimingStep(state, chainId) : ''}${draft.step === 2 ? renderAmountStep(state, chain.symbol, chainId) : ''}${draft.step === 3 ? renderReviewStep(state, chain.name, chain.symbol, chainId, owner, reviewReady, shortTimingRequired) : ''}
      ${draft.step === 0 ? `<label class="check-field draft-opt-in"><input id="draft-persistence" type="checkbox" data-draft-persistence ${state.draftPersistenceEnabled ? 'checked' : ''} ${state.storageAvailable ? '' : 'disabled'}><span><strong>Remember this draft on this device</strong>${state.storageAvailable ? '' : '<small>Unavailable in this browser. Reloading may clear your draft.</small>'}</span></label>` : ''}
      <div class="builder-nav">${draft.step === 0 ? '' : `<button class="button button--quiet" type="button" data-create-back="true">${icon('arrow')}<span>Back</span></button>`}${draft.step < 3 ? button('Continue', { className: 'js-create-next', icon: 'arrow' }) : button('Review and fund', { className: 'js-create-submit', icon: 'wallet', disabled: !reviewReady })}</div>
      ${fieldError(state, draft.step, chainId) ? `<p class="form-error" role="alert">${escapeHtml(fieldError(state, draft.step, chainId))}</p>` : ''}
    </div></section>
  </div>`;
}

function renderRecipientStep(state: AppState, owner: string): string {
  const draft = state.draft;
  const recipientError = draft.recipient.length > 0 || state.createValidationAttemptedStep === 0 ? draftErrors(state, selectedChainId(state)).find((error) => error.includes('address') || error.includes('recipient')) : undefined;
  const describedBy = recipientError ? 'recipient-help recipient-error' : 'recipient-help';
  return `<section class="builder-step" aria-labelledby="step-heading"><h2 id="step-heading">Recipient</h2><p class="step-copy">Enter the wallet address that can claim after the final deadline.</p><div class="field ${recipientError ? 'field--error' : ''}">${fieldLabel('recipient-address', 'Recipient address', 'Full 0x address')}<input id="recipient-address" data-draft-field="recipient" type="text" inputmode="text" autocomplete="off" spellcheck="false" value="${escapeHtml(draft.recipient)}" placeholder="0x…" aria-describedby="${describedBy}" aria-invalid="${Boolean(recipientError)}"><small id="recipient-help" class="field__help">Double-check this address. It determines who can claim.</small>${recipientError ? `<small id="recipient-error" class="field__error">${escapeHtml(recipientError)}</small>` : ''}</div><div class="field">${fieldLabel('plan-label', 'Plan label', 'Optional')}<input id="plan-label" data-draft-field="label" maxlength="60" type="text" value="${escapeHtml(draft.label)}" placeholder="Emergency fund"><small class="field__help">Only visible on this device.</small></div>${state.wallet.connected ? `<p class="create-owner">Owner <span class="wrap-anywhere">${escapeHtml(owner)}</span></p>` : ''}</section>`;
}

function renderTimingStep(state: AppState, chainId: ChainId): string {
  const draft = state.draft;
  const customTimingWithUnits = (field: 'inactivityPeriod' | 'gracePeriod', custom: boolean | undefined, id: string, label: string, hint: string, unitField: 'inactivity' | 'grace') => {
    const unit = customUnit(state, unitField);
    const value = draft[field] / unitMultiplier(unit);
    return `${fieldLabel(id, label, hint)}<select id="${id}" data-draft-field="${field}"><option value="2592000" ${!custom && draft[field] === 2592000 ? 'selected' : ''}>30 days</option><option value="7776000" ${!custom && draft[field] === 7776000 ? 'selected' : ''}>90 days</option><option value="15552000" ${!custom && draft[field] === 15552000 ? 'selected' : ''}>180 days</option><option value="604800" ${!custom && draft[field] === 604800 ? 'selected' : ''}>7 days</option><option value="1209600" ${!custom && draft[field] === 1209600 ? 'selected' : ''}>14 days</option><option value="custom" ${custom ? 'selected' : ''}>Custom value</option></select>${custom ? `<div class="custom-duration"><input type="number" min="1" step="1" value="${escapeHtml(String(value))}" data-custom-period="${field}" aria-label="Custom ${escapeHtml(label)} value"><select data-custom-unit="${field}" aria-label="Custom ${escapeHtml(label)} unit"><option value="seconds" ${unit === 'seconds' ? 'selected' : ''}>seconds</option><option value="minutes" ${unit === 'minutes' ? 'selected' : ''}>minutes</option><option value="hours" ${unit === 'hours' ? 'selected' : ''}>hours</option><option value="days" ${unit === 'days' ? 'selected' : ''}>days</option></select></div>` : ''}`;
  };
  const schedule = draftSchedule(state, chainId);
  return `<section class="builder-step" aria-labelledby="step-heading"><h2 id="step-heading">Schedule</h2><p class="step-copy">Choose when you check in and how much extra time you have if you miss it.</p><div class="timing-grid"><div class="field">${customTimingWithUnits('inactivityPeriod', draft.inactivityCustom, 'inactivity-days', 'Check-in interval', 'When the owner checks in', 'inactivity')}</div><div class="field">${customTimingWithUnits('gracePeriod', draft.graceCustom, 'grace-days', 'Grace period', 'Extra time after a miss', 'grace')}</div></div>${schedule.checkInBy && schedule.claimableAt ? `<div class="timing-boundaries"><div><span>Next check-in</span><strong>${escapeHtml(scheduleText(schedule.checkInBy))}</strong></div><div><span>Claim available</span><strong>${escapeHtml(scheduleText(schedule.claimableAt))}</strong></div></div><small class="field__help">Final dates are set when funding is confirmed.</small>` : '<p class="timing-preview-note">Connect your wallet to preview the dates.</p>'}</section>`;
}

function renderAmountStep(state: AppState, chainSymbol: string, chainId: ChainId): string {
  const draft = state.draft;
  const invalid = state.createValidationAttemptedStep === 2 || (draft.amount.length > 0 && (!amountHasValidPrecision(draft.amount) || parseNativeAmount(draft.amount) === 0n));
  const amountHelpId = invalid ? 'plan-amount-error' : 'plan-amount-help';
  const balanceText = state.walletBalance !== undefined ? `${escapeHtml(formatNativeAmount(state.walletBalance))} available` : state.walletBalanceLoading ? 'Reading chain balance…' : state.walletBalanceError ? 'Balance read unavailable' : state.wallet.connected ? 'Reading chain balance…' : 'Connect wallet to check';
  return `<section class="builder-step" aria-labelledby="step-heading"><h2 id="step-heading">Amount</h2><p class="step-copy">This amount is funded once. Leave room for the network fee.</p><div class="field ${invalid ? 'field--error' : ''}">${fieldLabel('plan-amount', 'Amount')}<div class="amount-input"><input id="plan-amount" data-draft-field="amount" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(draft.amount)}" aria-describedby="${amountHelpId}" aria-invalid="${invalid}"><span>${escapeHtml(chainSymbol)}</span></div>${invalid ? '<small id="plan-amount-error" class="field__error">Use a positive decimal amount with up to 18 places.</small>' : '<small id="plan-amount-help" class="field__help">The full amount will be held by the plan.</small>'}</div><div class="amount-review"><div><span>Connected balance</span><strong>${balanceText}</strong></div><div><span>Estimated fee</span><strong>${escapeHtml(estimatedFeeText(state, chainId))}</strong></div></div>${state.createFeeEstimateError ? diagnosticDetails(state.createFeeEstimateError) : ''}</section>`;
}

function renderReviewStep(state: AppState, chainName: string, chainSymbol: string, chainId: ChainId, owner: string, ready: boolean, shortTimingRequired: boolean): string {
  const draft = state.draft;
  const schedule = draftSchedule(state, chainId);
  const deploymentReady = Boolean(manifests[chainId].contractAddress && manifests[chainId].verificationStatus === 'verified');
  return `<section class="builder-step" aria-labelledby="step-heading"><h2 id="step-heading">Review</h2><p class="step-copy">Check the details before opening your wallet.</p><div class="review-card"><div class="review-card__header"><span>Plan details</span>${statusPill(ready ? 'Ready for wallet' : 'Needs attention', ready ? 'active' : 'neutral')}</div><div class="review-grid"><div><span>Owner</span><strong class="wrap-anywhere">${escapeHtml(owner)}</strong></div><div><span>Recipient</span><strong class="wrap-anywhere">${escapeHtml(draft.recipient || 'Not set')}</strong></div><div><span>Network</span><strong>${escapeHtml(chainName)}</strong></div><div><span>Amount</span><strong>${escapeHtml(draft.amount || '—')} ${escapeHtml(chainSymbol)}</strong></div><div><span>Check-in interval</span><strong>${escapeHtml(formatDuration(draft.inactivityPeriod))}</strong></div><div><span>Grace period</span><strong>${escapeHtml(formatDuration(draft.gracePeriod))}</strong></div><div><span>Next check-in</span><strong>${escapeHtml(scheduleText(schedule.checkInBy))}</strong></div><div><span>Claim available</span><strong>${escapeHtml(scheduleText(schedule.claimableAt))}</strong></div><div><span>Estimated fee</span><strong>${escapeHtml(estimatedFeeText(state, chainId))}</strong></div></div></div><div class="acknowledgements"><label class="check-field"><input type="checkbox" data-ack="0" ${draft.acknowledgements[0] ? 'checked' : ''}><span>After the final deadline, I can no longer reset or close this plan.</span></label><label class="check-field"><input type="checkbox" data-ack="1" ${draft.acknowledgements[1] ? 'checked' : ''}><span>Only a confirmed check-in for this plan resets its schedule.</span></label>${shortTimingRequired ? `<label class="check-field"><input type="checkbox" data-short-timing-ack ${draft.shortTimingAcknowledgement ? 'checked' : ''}><span>This mainnet plan uses a shorter timing window. I understand the dates depend on block inclusion.</span></label>` : ''}</div><p class="public-note">Plan details are public on this network. Claims are manual; funds never move automatically.</p>${!state.wallet.connected ? inlineNotice('Connect before funding', 'Connect a wallet to check the owner, balance, and fee.', 'warning') : ''}${!deploymentReady ? inlineNotice('Funding is unavailable', 'This network has no verified Lastlight deployment yet.', 'warning') : ''}</section>`;
}
