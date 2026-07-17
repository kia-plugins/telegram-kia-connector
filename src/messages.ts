/**
 * Api.Message → NormalizedMessage. Pure and duck-typed: the runtime hands in
 * plain shapes (production: GramJS custom Message objects, whose getters
 * satisfy the same ducks; tests: fixtures). Quote resolution goes through the
 * caller's lookup — no per-message API calls, ever.
 */
import { describeMedia } from './media';
import type { NormalizedMessage } from './types';

export const QUOTE_SNIPPET_MAX = 80;

export interface RawSenderLike {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  phone?: string | null;
  bot?: boolean;
}

export interface RawMessageLike {
  id: number;
  /** Epoch SECONDS (Telegram wire format). */
  date?: number;
  message?: string;
  out?: boolean;
  /** Present ⇒ service message (join/pin/call/…). */
  action?: unknown;
  media?: unknown;
  fwdFrom?: { fromName?: string };
  replyTo?: { replyToMsgId?: number };
  sender?: RawSenderLike | null;
}

/** Human label for the common service actions; generic fallback otherwise. */
function actionLabel(action: unknown): string {
  const cls = (action as { className?: string })?.className ?? '';
  const map: Record<string, string> = {
    MessageActionChatAddUser: 'added a member',
    MessageActionChatDeleteUser: 'removed a member',
    MessageActionChatJoinedByLink: 'joined via invite link',
    MessageActionChatCreate: 'created the group',
    MessageActionChatEditTitle: 'renamed the group',
    MessageActionChatEditPhoto: 'changed the group photo',
    MessageActionPinMessage: 'pinned a message',
    MessageActionPhoneCall: 'call',
    MessageActionHistoryClear: 'cleared history',
  };
  return map[cls] ?? 'service message';
}

export function senderName(msg: RawMessageLike, selfName: string): string {
  if (msg.out) return selfName;
  const s = msg.sender;
  if (s) {
    const full = [s.firstName, s.lastName].filter(Boolean).join(' ');
    if (full) return full;
    if (s.username) return s.username;
    if (s.phone) return `+${s.phone}`;
  }
  return 'Unknown';
}

export function normalizeMessage(
  msg: RawMessageLike,
  opts: {
    selfName: string;
    lookup?: (msgId: number) => NormalizedMessage | undefined;
  },
): NormalizedMessage | null {
  if (typeof msg.id !== 'number') return null;
  const tsMs = (msg.date ?? 0) * 1000;
  if (msg.action) {
    return {
      id: String(msg.id),
      tsMs,
      sender: null,
      text: actionLabel(msg.action),
      system: true,
    };
  }
  const media = describeMedia(msg.media);
  let text = msg.message ?? '';
  if (msg.fwdFrom?.fromName) text = `fwd from ${msg.fwdFrom.fromName}: ${text}`;
  if (!text && !media) return null; // nothing indexable (poll/webpage/geo shells)
  const out: NormalizedMessage = {
    id: String(msg.id),
    tsMs,
    sender: senderName(msg, opts.selfName),
    text,
    system: false,
  };
  if (media) out.media = media;
  const replyId = msg.replyTo?.replyToMsgId;
  if (replyId !== undefined && opts.lookup) {
    const target = opts.lookup(replyId);
    if (target) {
      out.quote = {
        sender: target.sender,
        snippet: target.text.slice(0, QUOTE_SNIPPET_MAX),
      };
    }
  }
  return out;
}
