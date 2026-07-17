import type { MediaDescriptor, NormalizedMessage } from './types';

export const DOC_TYPE = 'telegram.chat_day';

/** Local-calendar day key 'YYYY-MM-DD' for an epoch-ms timestamp. */
export function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Union of existing + incoming messages, deduped by id, ascending by ts. */
export function mergeMessages(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  const byId = new Map<string, NormalizedMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m); // incoming wins on conflict
  return [...byId.values()].sort(
    (a, b) => a.tsMs - b.tsMs || a.id.localeCompare(b.id),
  );
}

function hhmm(tsMs: number): string {
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

function mediaLabel(media: MediaDescriptor): string {
  if (media.kind === 'audio' && media.durationSec) {
    const mm = Math.floor(media.durationSec / 60);
    const ss = String(Math.floor(media.durationSec % 60)).padStart(2, '0');
    return `[voice note ${mm}:${ss}]`;
  }
  if (media.kind === 'document')
    return `[document: ${media.filename ?? 'file'}]`;
  return `[${media.kind}]`;
}

/**
 * Render the day's messages to markdown. Media renders as its label only —
 * navigation to the bytes is the `file` document's parent edge onto this day.
 */
export function renderDay(messages: NormalizedMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.system) {
      lines.push(`_${m.text}_`);
      continue;
    }
    const parts: string[] = [`${hhmm(m.tsMs)} ${m.sender ?? '?'}:`];
    if (m.quote) parts.push(`↳re ${m.quote.sender ?? '?'}: ${m.quote.snippet}`);
    if (m.media) parts.push(mediaLabel(m.media));
    if (m.text) parts.push(m.text);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** '<chatName> — Mon D, YYYY' for a 'YYYY-MM-DD' day key. */
export function dayTitle(chatName: string, key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${chatName} — ${MONTHS[m - 1]} ${d}, ${y}`;
}
