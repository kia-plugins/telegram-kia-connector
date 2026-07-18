/** A single chat message after normalization from either ingest path. */
export interface NormalizedMessage {
  /** Stable id: Telegram's per-chat message id as a string. */
  id: string;
  /** Epoch milliseconds (Telegram's date is seconds — converted upstream). */
  tsMs: number;
  /** Display name of the sender, already resolved. null ⇒ system message. */
  sender: string | null;
  /** Plain text body (caption for media, '' for pure media messages). */
  text: string;
  /** Present when the message carries media. */
  media?: MediaDescriptor;
  /** Quoted/replied-to message, rendered inline. */
  quote?: { sender: string | null; snippet: string };
  /** True for Telegram service messages ("X joined", pins, calls…). */
  system: boolean;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface MediaDescriptor {
  kind: MediaKind;
  /** Original filename if known (document messages). */
  filename?: string;
  /** Mime type if known. */
  mimeType?: string;
  /** Duration seconds for audio/video, for the placeholder label. */
  durationSec?: number;
}

/** Resolved chat identity at flush time. */
export interface ChatInfo {
  /** Marked Telegram chat id (teleproto Dialog.id) as a string. */
  chatId: string;
  name: string;
  type: 'dm' | 'group';
}

/** Per-chat walk state — the unit of backfill/catch-up resumability. */
export interface ChatProgress {
  /** Oldest message id already ingested; the walk continues BELOW it. */
  oldestId?: number;
  /** True once the walk reached message #1. */
  complete: boolean;
  /** Newest message timestamp (ms) seen — the catch-up watermark. */
  newestTsMs: number;
}

/** Account.cursor shape, committed transactionally with every batch. */
export interface TelegramCursor {
  chats: Record<string, ChatProgress>;
}

/** One (chat, local-day) document with its COMPLETE merged message ledger. */
export interface DayItem {
  kind: 'day';
  chat: ChatInfo;
  /** Local-calendar day key 'YYYY-MM-DD'. */
  day: string;
  /** Full merged ledger for the day, ascending (ts, id). */
  messages: NormalizedMessage[];
}

/** Downloaded media bytes for one message, parented under its day item. */
export interface FileItem {
  kind: 'file';
  chatId: string;
  /** Local day key of the owning chat-day (the parent edge). */
  day: string;
  msgId: string;
  bytes: Uint8Array;
  mediaKind: MediaKind;
  /** JSON re-fetch ref (media.ts buildRef) — persisted as metadata.tg_msg. */
  ref: string;
  mimeType?: string;
  filename?: string;
  /** Epoch-ms send time of the carrying message (drives createdAt). */
  sentAtMs: number;
}

export type TelegramItem = DayItem | FileItem;

/** A dialog that passed filtering, with what the walker needs to fetch it. */
export interface IncludedChat {
  chatId: string;
  name: string;
  type: 'dm' | 'group';
  /** teleproto entity (User/Chat/Channel) — passed to iterMessages verbatim. */
  entity: unknown;
  /** Epoch ms of the dialog's last message (recent-first ordering). */
  lastMessageTsMs: number;
}
