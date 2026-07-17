/**
 * Media plumbing: duck-typed descriptor extraction from GramJS message media,
 * declared-size pre-checks, synthetic filenames, and the tg_msg re-fetch ref.
 * The ref stores peer type + access hash because a fresh StringSession client
 * has NO entity cache — fetchBytes must rebuild the InputPeer from metadata
 * alone, never from getEntity().
 */
import { Api } from 'telegram';
import bigInt from 'big-integer';

import type { MediaDescriptor, MediaKind } from './types';

export const FILE_DOC_TYPE = 'telegram.file';

/** Download cap; larger media stays a placeholder (no bytes fetched). */
export const MEDIA_SIZE_CAP_BYTES = 25 * 1024 * 1024;

/** Backfill media window: bytes only for messages newer than this. Older
 *  media keeps its transcript label; full TEXT history is never windowed. */
export const MEDIA_BACKFILL_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

interface DocAttrLike {
  className?: string;
  fileName?: string;
  duration?: number;
  voice?: boolean;
}

interface MediaLike {
  className?: string;
  photo?: unknown;
  document?: {
    size?: unknown;
    mimeType?: string;
    attributes?: DocAttrLike[];
  };
}

/** GramJS Api.TypeMessageMedia → our descriptor; undefined = not indexable
 *  media (webpage previews, polls, geo — their text lives in the message). */
export function describeMedia(media: unknown): MediaDescriptor | undefined {
  const m = media as MediaLike | undefined;
  if (!m || typeof m !== 'object') return undefined;
  // Telegram re-encodes all photos server-side to JPEG; the platform's
  // vision routing keys off metadata.mime, so it must be present here.
  if (m.className === 'MessageMediaPhoto' && m.photo)
    return { kind: 'image', mimeType: 'image/jpeg' };
  if (m.className !== 'MessageMediaDocument' || !m.document) return undefined;
  const doc = m.document;
  const attrs = Array.isArray(doc.attributes) ? doc.attributes : [];
  const byClass = (name: string): DocAttrLike | undefined =>
    attrs.find((a) => a?.className === name);
  const audio = byClass('DocumentAttributeAudio');
  const video = byClass('DocumentAttributeVideo');
  const named = byClass('DocumentAttributeFilename');
  let kind: MediaKind = 'document';
  let durationSec: number | undefined;
  if (byClass('DocumentAttributeSticker')) kind = 'sticker';
  else if (audio) {
    kind = 'audio';
    durationSec = typeof audio.duration === 'number' ? audio.duration : undefined;
  } else if (video) {
    kind = 'video';
    durationSec = typeof video.duration === 'number' ? video.duration : undefined;
  } else if (doc.mimeType?.startsWith('image/')) kind = 'image';
  const out: MediaDescriptor = { kind };
  if (doc.mimeType) out.mimeType = doc.mimeType;
  if (named?.fileName) out.filename = named.fileName;
  if (durationSec !== undefined) out.durationSec = durationSec;
  return out;
}

/** Declared byte size for documents (BigInteger-safe); photos: undefined —
 *  Telegram photos are re-compressed and comfortably under the cap. */
export function declaredSizeBytes(media: unknown): number | undefined {
  const m = media as MediaLike | undefined;
  const size = m?.document?.size as
    | number
    | { toJSNumber?: () => number }
    | undefined;
  if (typeof size === 'number') return size;
  if (size && typeof size.toJSNumber === 'function') return size.toJSNumber();
  return undefined;
}

const SYNTHETIC: Record<MediaKind, string> = {
  image: 'photo.jpg',
  audio: 'voice-note.ogg',
  video: 'video.mp4',
  sticker: 'sticker.webp',
  document: 'file',
};

export function attachmentFilename(d: MediaDescriptor): string {
  return d.filename ?? SYNTHETIC[d.kind];
}

/** 'report.PDF' → 'pdf'; undefined when there's no usable extension. */
export function extOf(filename: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename);
  return m ? m[1].toLowerCase() : undefined;
}

/** The persisted deep-extraction ref (metadata.tg_msg). */
export interface TgRef {
  chatId: string;
  msgId: number;
  peer: 'user' | 'chat' | 'channel';
  accessHash?: string;
}

export function buildRef(ref: TgRef): string {
  return JSON.stringify(ref);
}

export function parseRef(s: unknown): TgRef | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  try {
    const v = JSON.parse(s) as Partial<TgRef>;
    if (
      typeof v.chatId !== 'string' ||
      typeof v.msgId !== 'number' ||
      (v.peer !== 'user' && v.peer !== 'chat' && v.peer !== 'channel')
    )
      return null;
    const out: TgRef = { chatId: v.chatId, msgId: v.msgId, peer: v.peer };
    if (typeof v.accessHash === 'string') out.accessHash = v.accessHash;
    return out;
  } catch {
    return null;
  }
}

/** Marked chat id → bare positive id (strip '-100' channel / '-' chat marks). */
function bareId(chatId: string): ReturnType<typeof bigInt> {
  if (chatId.startsWith('-100')) return bigInt(chatId.slice(4));
  if (chatId.startsWith('-')) return bigInt(chatId.slice(1));
  return bigInt(chatId);
}

/** Rebuild the InputPeer for getMessages from the ref alone. */
export function inputPeerFor(ref: TgRef): unknown {
  const id = bareId(ref.chatId);
  const hash = bigInt(ref.accessHash ?? '0');
  if (ref.peer === 'user')
    return new Api.InputPeerUser({ userId: id, accessHash: hash });
  if (ref.peer === 'chat') return new Api.InputPeerChat({ chatId: id });
  return new Api.InputPeerChannel({ channelId: id, accessHash: hash });
}

/** Entity (from a live dialog walk) → the peer part of a TgRef. */
export function peerOfEntity(
  entity: unknown,
): { peer: TgRef['peer']; accessHash?: string } | null {
  const e = entity as
    | { className?: string; accessHash?: { toString(): string } }
    | null;
  if (!e || typeof e !== 'object') return null;
  if (e.className === 'User')
    return { peer: 'user', accessHash: e.accessHash?.toString() };
  if (e.className === 'Chat') return { peer: 'chat' };
  if (e.className === 'Channel')
    return { peer: 'channel', accessHash: e.accessHash?.toString() };
  return null;
}
