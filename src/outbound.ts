/**
 * Reply targets for a Telegram chat-day document — what `metadata.outbound`
 * stores so kiagent-core's `draft_reply` can address a reply without the
 * model ever naming a chat: the day's chat (default), or one message in it
 * (`targets`, keyed by message id — the reply quotes that message).
 *
 * The ref is self-contained (peer class + access hash, like the media
 * `tg_msg` ref): the Sender uses a FRESH client, which has no entity cache.
 */
import type { ChatInfo, NormalizedMessage } from './types';

export interface TgOutboundRef {
  chatId: string;
  peer: 'user' | 'chat' | 'channel';
  accessHash?: string;
  /** Message id to reply to — a positive integer (teleproto rejects a
   *  string id). */
  replyTo?: number;
}

const hhmm = (tsMs: number): string => {
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function outboundFor(
  chat: ChatInfo,
  messages: NormalizedMessage[],
): Record<string, unknown> | undefined {
  // Users and channels are addressed by id + access hash; without the hash
  // Telegram cannot resolve them (basic groups need none).
  if (!chat.peer || (chat.peer.peer !== 'chat' && chat.peer.accessHash === undefined))
    return undefined;
  const ref: TgOutboundRef = {
    chatId: chat.chatId,
    peer: chat.peer.peer,
    ...(chat.peer.accessHash !== undefined ? { accessHash: chat.peer.accessHash } : {}),
  };
  return {
    ref,
    display: chat.name,
    targets: messages
      .filter((m) => !m.system && /^[1-9]\d*$/.test(m.id))
      .map((m) => ({
        key: m.id,
        ref: { ...ref, replyTo: Number(m.id) },
        display: `${chat.name} (reply to ${m.sender ?? '?'} · ${hhmm(m.tsMs)})`,
      })),
  };
}

/** The stored ref as the Sender receives it (round-tripped verbatim by
 *  core) — re-validated: it crossed a process and a database. */
export function parseOutboundRef(v: unknown): TgOutboundRef | null {
  const r = v as Partial<TgOutboundRef> | null | undefined;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.chatId !== 'string' || !/^-?\d+$/.test(r.chatId)) return null;
  if (r.peer !== 'user' && r.peer !== 'chat' && r.peer !== 'channel') return null;
  if (r.accessHash !== undefined && typeof r.accessHash !== 'string') return null;
  if (r.replyTo !== undefined && !(Number.isSafeInteger(r.replyTo) && r.replyTo > 0))
    return null;
  return {
    chatId: r.chatId,
    peer: r.peer,
    ...(r.accessHash !== undefined ? { accessHash: r.accessHash } : {}),
    ...(r.replyTo !== undefined ? { replyTo: r.replyTo } : {}),
  };
}
