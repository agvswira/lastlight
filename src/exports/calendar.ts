import { chains } from '../app/config';
import { formatDateUtc, getReminderLead } from '../domain/policy';
import type { Plan } from '../domain/types';

function escapeIcs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function foldLine(line: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let byteLength = 0;
  let limit = 75;
  for (const character of line) {
    const characterBytes = new TextEncoder().encode(character).length;
    if (chunk && byteLength + characterBytes > limit) {
      chunks.push(chunk);
      chunk = ` ${character}`;
      byteLength = 1 + characterBytes;
      limit = 75;
    } else {
      chunk += character;
      byteLength += characterBytes;
    }
  }
  chunks.push(chunk);
  return chunks;
}

function icsUtc(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z');
}

export function buildReminderIcs(plan: Pick<Plan, 'chainId' | 'contract' | 'vaultId' | 'owner' | 'lastHeartbeat' | 'inactivityPeriod' | 'claimableAt'>, revision = 0, reminderAtOverride?: number): string {
  const defaultReminderAt = Number(plan.lastHeartbeat) + Number(plan.inactivityPeriod) - getReminderLead(Number(plan.inactivityPeriod));
  const reminderAt = reminderAtOverride ?? defaultReminderAt;
  const end = reminderAt + 30 * 60;
  const chain = chains[plan.chainId];
  const uid = `lastlight-${plan.chainId}-${plan.contract.toLowerCase()}-${plan.vaultId.toString()}-owner-reminder@lastlight`;
  const description = `Check in for Lastlight plan ${plan.vaultId.toString()}.\nCheck-in by: ${formatDateUtc(Number(plan.lastHeartbeat) + Number(plan.inactivityPeriod), true)}.\nFinal deadline: ${formatDateUtc(Number(plan.claimableAt), true)}.\nThis is a local snapshot reminder; it does not sync after a check-in. Read the current chain state before acting.\n${locationHref(plan)}`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lastlight//Continuity reminder//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${escapeIcs(uid)}`, `DTSTAMP:${icsUtc(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${icsUtc(reminderAt)}`, `DTEND:${icsUtc(end)}`, `SEQUENCE:${Math.max(0, Math.floor(revision))}`,
    `SUMMARY:${escapeIcs('Check in to Lastlight')}`, `DESCRIPTION:${escapeIcs(description)}`, `URL:${escapeIcs(locationHref(plan))}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.flatMap(foldLine).join('\r\n') + '\r\n';
}

export function buildRecipientIcs(plan: Pick<Plan, 'chainId' | 'contract' | 'vaultId' | 'successor' | 'claimableAt'>, revision = 0): string {
  const location = locationHref(plan);
  const uid = `lastlight-${plan.chainId}-${plan.contract.toLowerCase()}-${plan.vaultId.toString()}-recipient@lastlight`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lastlight//Recipient reminder//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:${escapeIcs(uid)}`, `DTSTAMP:${icsUtc(Math.floor(Date.now() / 1000))}`,
    `DTSTART:${icsUtc(Number(plan.claimableAt))}`, `DTEND:${icsUtc(Number(plan.claimableAt) + 30 * 60)}`,
    `SEQUENCE:${Math.max(0, Math.floor(revision))}`, `SUMMARY:${escapeIcs('Check whether claiming is open')}`,
    `DESCRIPTION:${escapeIcs(`Check whether Lastlight plan ${plan.vaultId.toString()} is claimable. The date can move if the owner checks in. Calendar time is not proof of eligibility.\n${location}`)}`,
    `URL:${escapeIcs(location)}`, 'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.flatMap(foldLine).join('\r\n') + '\r\n';
}

function locationHref(plan: Pick<Plan, 'chainId' | 'contract' | 'vaultId'>): string {
  return `${window.location.origin}${window.location.pathname}#/plan/${plan.chainId}/${plan.contract}/${plan.vaultId.toString()}`;
}

export function downloadText(filename: string, content: string, type = 'text/plain;charset=utf-8'): boolean {
  try {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
