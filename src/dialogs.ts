/**
 * Which conversations get indexed: user DMs (not bots, not Telegram's 777000
 * service account, Saved Messages included), basic groups, and megagroups.
 * Broadcast channels are out — they're feeds, not personal memory. Megagroups
 * report BOTH isGroup and isChannel in GramJS; the isGroup check runs first
 * so they land as groups.
 */
import type { IncludedChat } from './types';

export const SERVICE_USER_ID = '777000';

export interface RawDialogLike {
  isUser: boolean;
  isGroup: boolean;
  isChannel: boolean;
  /** GramJS BigInteger (marked id) — anything with toString(). */
  id?: unknown;
  name?: string;
  title?: string;
  /** Epoch seconds of the dialog's last message. */
  date?: number;
  entity?: unknown;
}

export function classifyDialog(
  d: RawDialogLike,
  selfId: string,
): IncludedChat | null {
  if (d.id === undefined || d.id === null) return null;
  const chatId = String(d.id);
  const lastMessageTsMs = (d.date ?? 0) * 1000;
  const entity = d.entity ?? {};
  const name = d.name ?? d.title ?? chatId;
  if (d.isGroup) {
    return { chatId, name, type: 'group', entity, lastMessageTsMs };
  }
  if (d.isChannel) return null; // broadcast
  if (d.isUser) {
    const e = entity as { bot?: boolean };
    if (e.bot) return null;
    if (chatId === SERVICE_USER_ID) return null;
    if (chatId === selfId) {
      return { chatId, name: 'Saved Messages', type: 'dm', entity, lastMessageTsMs };
    }
    return { chatId, name, type: 'dm', entity, lastMessageTsMs };
  }
  return null;
}
