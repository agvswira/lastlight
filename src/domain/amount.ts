export const NATIVE_DECIMALS = 18;

export function parseNativeAmount(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,18})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  try {
    return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0') || '0');
  } catch {
    return null;
  }
}

export function formatNativeAmount(value: bigint | string, maximumFractionDigits = 4): string {
  const amount = typeof value === 'string' ? BigInt(value) : value;
  const whole = amount / 10n ** 18n;
  const remainder = amount % 10n ** 18n;
  if (remainder === 0n) return `${whole} BOT`;
  const fraction = remainder.toString().padStart(18, '0').replace(/0+$/, '');
  const visible = fraction.slice(0, Math.max(1, maximumFractionDigits));
  if (fraction.length > visible.length) {
    if (whole === 0n && /^0+$/.test(visible)) return `<0.${'0'.repeat(Math.max(0, visible.length - 1))}1 BOT`;
    return `${whole}.${visible}… BOT`;
  }
  return `${whole}.${visible} BOT`;
}

export function amountHasValidPrecision(value: string): boolean {
  return /^\d+(?:\.\d{1,18})?$/.test(value.trim()) && parseNativeAmount(value) !== null;
}
