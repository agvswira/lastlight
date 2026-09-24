export function escapeHtml(value: string | number | bigint | undefined | null): string {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character));
}

export function sanitizeDiagnostic(value: unknown): string {
  const raw = value instanceof Error
    ? [value.name, value.message, value.cause instanceof Error ? value.cause.message : typeof value.cause === 'string' ? value.cause : ''].filter(Boolean).join(': ')
    : String(value ?? '');
  const redacted = raw.replace(/(["']?(?:private\s*key|seed\s*phrase|mnemonic|secret|password|api[-_\s]?key|access[-_\s]?token|auth[-_\s]?token)["']?)\s*[:=]\s*["']?[^,;\n"']+["']?/gi, '$1: [redacted]');
  const normalized = redacted.replace(/\s+/g, ' ').trim();
  return normalized.length > 600 ? `${normalized.slice(0, 597)}…` : normalized;
}

export function diagnosticDetails(value: unknown): string {
  const detail = sanitizeDiagnostic(value);
  return detail ? `<details class="diagnostic-details"><summary>Technical details</summary><pre>${escapeHtml(detail)}</pre></details>` : '';
}

export function icon(name: 'arrow' | 'plus' | 'check' | 'clock' | 'copy' | 'external' | 'wallet' | 'warning' | 'download' | 'spark'): string {
  const paths: Record<string, string> = {
    arrow: '<path d="M5 12h13M13 6l6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    copy: '<rect x="8" y="8" width="10" height="10" rx="1.5"/><path d="M6 16H5.5A1.5 1.5 0 0 1 4 14.5v-9A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5V6"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
    wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 16.5v-9Z"/><path d="M4 8h14a2 2 0 0 1 2 2v2h-5a2 2 0 0 0 0 4h5"/><circle cx="15" cy="14" r=".5" fill="currentColor"/>',
    warning: '<path d="M12 4 3.5 19h17L12 4Z"/><path d="M12 9v4M12 16v.5"/>',
    download: '<path d="M12 4v10M8 11l4 4 4-4M5 19h14"/>',
    spark: '<path d="m12 3 1.6 6.4L20 11l-6.4 1.6L12 19l-1.6-6.4L4 11l6.4-1.6L12 3Z"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

export function button(label: string, options: { href?: string; variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; icon?: Parameters<typeof icon>[0]; className?: string; disabled?: boolean; type?: 'button' | 'submit' } = {}): string {
  const classes = ['button', `button--${options.variant ?? 'primary'}`, options.className ?? ''].filter(Boolean).join(' ');
  const iconMarkup = options.icon ? icon(options.icon) : '';
  const disabled = options.disabled ? ' disabled aria-disabled="true"' : '';
  if (options.href) return `<a class="${classes}" href="${escapeHtml(options.href)}"${options.disabled ? ' aria-disabled="true"' : ''}>${iconMarkup}<span>${escapeHtml(label)}</span></a>`;
  return `<button class="${classes}" type="${options.type ?? 'button'}"${disabled}>${iconMarkup}<span>${escapeHtml(label)}</span></button>`;
}

export function fieldLabel(id: string, label: string, hint = ''): string {
  return `<label class="field__label" for="${escapeHtml(id)}">${escapeHtml(label)}${hint ? `<span class="field__hint">${escapeHtml(hint)}</span>` : ''}</label>`;
}

export function copyButton(value: string, label = 'Copy'): string {
  return `<button class="icon-button js-copy" type="button" data-copy="${escapeHtml(value)}" aria-label="${escapeHtml(label)}">${icon('copy')}<span class="sr-only">${escapeHtml(label)}</span></button>`;
}

export function statusPill(label: string, tone: 'active' | 'grace' | 'claimable' | 'terminal' | 'neutral' = 'neutral'): string {
  return `<span class="status-pill status-pill--${tone}"><span class="status-pill__dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

export function formatStatusTone(status: string): 'active' | 'grace' | 'claimable' | 'terminal' | 'neutral' {
  if (status === 'ACTIVE') return 'active';
  if (status === 'GRACE') return 'grace';
  if (status === 'CLAIMABLE') return 'claimable';
  if (status === 'CLAIMED' || status === 'CANCELLED') return 'terminal';
  return 'neutral';
}
