import { escapeHtml, icon } from './ui';

export type ActionDialogData = {
  id: string;
  title: string;
  description: string;
  actionLabel: string;
  rows: Array<[string, string]>;
  fields?: Array<{ id: string; label: string; value?: string; hint?: string; required?: boolean }>;
  fee?: string;
  warning?: string;
};

export function renderActionDialog(data: ActionDialogData): string {
  return `<dialog class="action-dialog" id="${escapeHtml(data.id)}" aria-labelledby="${escapeHtml(data.id)}-title" aria-describedby="${escapeHtml(data.id)}-description"><form method="dialog"><button class="dialog-close icon-button" value="cancel" aria-label="Close dialog">×</button><p class="eyebrow">Review action</p><h2 id="${escapeHtml(data.id)}-title">${escapeHtml(data.title)}</h2><p id="${escapeHtml(data.id)}-description" class="dialog-description">${escapeHtml(data.description)}</p><dl class="dialog-summary">${data.rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}${data.fee !== undefined ? `<div data-dialog-fee><dt>Estimated fee</dt><dd>${escapeHtml(data.fee)}</dd></div>` : ''}</dl>${data.fields?.length ? `<div class="dialog-fields">${data.fields.map((field) => `<div class="field"><label class="field__label" for="${escapeHtml(field.id)}">${escapeHtml(field.label)}</label><input id="${escapeHtml(field.id)}" name="${escapeHtml(field.id)}" type="text" inputmode="text" autocomplete="off" spellcheck="false" value="${escapeHtml(field.value ?? '')}" ${field.required ? 'required' : ''} aria-describedby="${escapeHtml(field.id)}-hint"><small id="${escapeHtml(field.id)}-hint" class="field__help">${escapeHtml(field.hint ?? 'Full 0x address')}</small></div>`).join('')}</div>` : ''}${data.warning ? `<div class="dialog-warning">${icon('warning')}<p>${escapeHtml(data.warning)}</p></div>` : ''}<div class="dialog-actions"><button class="button button--quiet" value="cancel">Cancel</button><button class="button button--primary" value="confirm" data-dialog-confirm="${escapeHtml(data.id)}">${icon('wallet')}<span>${escapeHtml(data.actionLabel)}</span></button></div></form></dialog>`;
}

export function openActionDialog(id: string): HTMLDialogElement | null {
  const dialog = document.getElementById(id);
  if (!(dialog instanceof HTMLDialogElement)) return null;
  dialog.showModal();
  return dialog;
}
