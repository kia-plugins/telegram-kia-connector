/**
 * The per-account pull engine: owns ONE GramJS client, buckets normalized
 * messages by (chat, local day) from BOTH ingest paths (history walker +
 * live events), merges each flush against the prior stored ledger, and
 * pushes batches into the queue the pull() generator drains. Mirrors the
 * WhatsApp connector's runtime discipline: the open generator IS the
 * realtime path, flushes are serialized, stop() is idempotent.
 */
import { dayKey, mergeMessages } from './chat-day';
import type { TgClient } from './client';
import { classifyDialog, type RawDialogLike } from './dialogs';
import {
  attachmentFilename,
  buildRef,
  declaredSizeBytes,
  MEDIA_BACKFILL_WINDOW_MS,
  MEDIA_SIZE_CAP_BYTES,
  peerOfEntity,
} from './media';
import { normalizeMessage, type RawMessageLike } from './messages';
import { AsyncBatchQueue } from './queue';
import type { Batch, LogLevel } from './kiagent-contracts';
import type {
  ChatInfo,
  FileItem,
  IncludedChat,
  NormalizedMessage,
  TelegramCursor,
  TelegramItem,
} from './types';
import { walkChats } from './walker';

export const FLUSH_DEBOUNCE_MS = 3000;
export const RECENT_INDEX_CAP = 2000;

const AUTH_LOSS = [
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
];

export function isAuthLossError(err: unknown): boolean {
  const e = err as { errorMessage?: unknown; message?: unknown };
  const text = `${String(e?.errorMessage ?? '')} ${String(e?.message ?? '')}`;
  return AUTH_LOSS.some((code) => text.includes(code));
}

export interface RuntimeDeps {
  client: TgClient;
  initialCursor: TelegramCursor | null;
  /** GramJS event builders (NewMessage / EditedMessage instances) — injected
   *  so tests pass sentinels and invoke the captured handlers directly. */
  events: { newMessage: unknown; editedMessage: unknown };
  loadPriorMessages(externalId: string): Promise<NormalizedMessage[] | null>;
  hasStoredFile(externalId: string): Promise<boolean>;
  log(level: LogLevel, msg: string): void;
  nowMs?: () => number;
  flushDebounceMs?: number;
  commitEvery?: number;
  catchUpOverlapMs?: number;
  mediaWindowMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type TgBatch = Batch<TelegramCursor, TelegramItem>;

interface Bucket {
  chat: ChatInfo;
  byId: Map<string, NormalizedMessage>;
}

export class TelegramPullRuntime {
  loggedOut = false;

  fatalError: Error | null = null;

  private readonly deps: RuntimeDeps;

  private readonly queue = new AsyncBatchQueue<TgBatch>();

  private readonly ctrl = new AbortController();

  private cursor: TelegramCursor;

  private readonly chatsById = new Map<string, IncludedChat>();

  /** (chatId → day → messages) pending flush. */
  private readonly buckets = new Map<string, Map<string, Bucket>>();

  private pendingFiles: FileItem[] = [];

  /** Per-chat recent messages for reply-quote resolution. */
  private readonly recent = new Map<string, Map<number, NormalizedMessage>>();

  private flushChain: Promise<void> = Promise.resolve();

  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private walkPromise: Promise<void> | null = null;

  private walking = true;

  private selfName = 'Me';

  private stopped = false;

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
    this.cursor = deps.initialCursor
      ? (JSON.parse(JSON.stringify(deps.initialCursor)) as TelegramCursor)
      : { chats: {} };
    if (!this.cursor.chats) this.cursor = { chats: {} };
  }

  async start(): Promise<void> {
    const { client } = this.deps;
    await client.connect();
    const me = await client.getMe();
    const selfId = String(me.id);
    this.selfName = me.firstName ?? me.username ?? 'Me';

    // Handlers attach BEFORE the walk starts so nothing sent during a long
    // backfill is missed; day-merge dedup absorbs the overlap.
    client.addEventHandler(this.onLiveEvent, this.deps.events.newMessage);
    client.addEventHandler(this.onLiveEvent, this.deps.events.editedMessage);

    const included: IncludedChat[] = [];
    for await (const raw of client.iterDialogs({ ignoreMigrated: true })) {
      const chat = classifyDialog(raw as RawDialogLike, selfId);
      if (chat) included.push(chat);
    }
    included.sort((a, b) => b.lastMessageTsMs - a.lastMessageTsMs);
    for (const c of included) this.chatsById.set(c.chatId, c);
    this.deps.log(
      'info',
      `telegram: syncing ${included.length} chats (DMs + groups)`,
    );

    this.walkPromise = walkChats({
      client,
      chats: included,
      cursor: this.cursor,
      signal: this.ctrl.signal,
      emitMessage: (chat, m) => this.ingest(chat, m, 'backfill'),
      commitPoint: () => this.flush('backfill'),
      // WalkerDeps allows a 'debug' level the vendored LogLevel doesn't;
      // map it to 'info' so a future walker 'debug' call can't leak an
      // out-of-union value to the host.
      log: (l, m) => this.deps.log(l === 'debug' ? 'info' : l, m),
      commitEvery: this.deps.commitEvery,
      catchUpOverlapMs: this.deps.catchUpOverlapMs,
      sleep: this.deps.sleep,
    })
      .then(() => {
        this.walking = false;
        this.deps.log('info', 'telegram: history walk caught up — live only');
      })
      .catch((err: Error) => {
        this.fatal(err);
      });
  }

  nextBatch(): Promise<TgBatch | null> {
    return this.queue.next();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.ctrl.abort();
    await this.walkPromise?.catch(() => {});
    await this.flush(this.walking ? 'backfill' : 'live');
    this.queue.close();
    try {
      await this.deps.client.disconnect();
    } catch {
      /* ignore — transport may already be down */
    }
  }

  /** Both live handlers funnel here (new + edited: same merge-by-id path). */
  private readonly onLiveEvent = async (event: unknown): Promise<void> => {
    try {
      const ev = event as {
        chatId?: { toString(): string };
        message?: RawMessageLike & { chatId?: { toString(): string } };
      };
      const raw = ev.message;
      if (!raw || typeof raw.id !== 'number') return;
      const chatId = String(ev.chatId ?? raw.chatId ?? '');
      const chat = this.chatsById.get(chatId);
      if (!chat) return; // excluded, unknown, or created after start — next run
      await this.ingest(chat, raw, 'live');
      this.scheduleLiveFlush();
    } catch (err) {
      this.deps.log('warn', `telegram: live event dropped — ${String(err)}`);
    }
  };

  /** Normalize + bucket one message; download its media when eligible. */
  private async ingest(
    chat: IncludedChat,
    raw: RawMessageLike,
    origin: 'backfill' | 'live',
  ): Promise<void> {
    const index = this.recentIndexFor(chat.chatId);
    const m = normalizeMessage(raw, {
      selfName: this.selfName,
      lookup: (id) => index.get(id),
    });
    if (!m) return;
    this.remember(chat.chatId, raw.id, m);

    const day = dayKey(m.tsMs);
    const chatBuckets =
      this.buckets.get(chat.chatId) ??
      this.buckets.set(chat.chatId, new Map()).get(chat.chatId)!;
    const bucket =
      chatBuckets.get(day) ??
      chatBuckets
        .set(day, {
          chat: { chatId: chat.chatId, name: chat.name, type: chat.type },
          byId: new Map(),
        })
        .get(day)!;
    bucket.byId.set(m.id, m);

    await this.maybeDownloadMedia(chat, raw, m, day, origin);
  }

  private async maybeDownloadMedia(
    chat: IncludedChat,
    raw: RawMessageLike,
    m: NormalizedMessage,
    day: string,
    origin: 'backfill' | 'live',
  ): Promise<void> {
    if (!m.media || m.system) return;
    const nowMs = this.deps.nowMs?.() ?? Date.now();
    const windowMs = this.deps.mediaWindowMs ?? MEDIA_BACKFILL_WINDOW_MS;
    if (origin === 'backfill' && m.tsMs < nowMs - windowMs) return;
    const declared = declaredSizeBytes(raw.media);
    if (declared !== undefined && declared > MEDIA_SIZE_CAP_BYTES) return;
    const fileExternalId = `${chat.chatId}:${m.id}`;
    if (await this.deps.hasStoredFile(fileExternalId)) return;
    const peer = peerOfEntity(chat.entity);
    let bytes: Buffer | string | undefined;
    try {
      // Backfill downloads are serialized by the walker's await; a live
      // event's download may briefly overlap one backfill download —
      // bounded, acceptable.
      bytes = await this.deps.client.downloadMedia(raw, {});
    } catch (err) {
      this.deps.log('warn', `telegram: media download failed for ${fileExternalId} — ${String(err)}`);
      return;
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return;
    if (bytes.length > MEDIA_SIZE_CAP_BYTES) return;
    const file: FileItem = {
      kind: 'file',
      chatId: chat.chatId,
      day,
      msgId: m.id,
      bytes: new Uint8Array(bytes),
      mediaKind: m.media.kind,
      ref: peer
        ? buildRef({
            chatId: chat.chatId,
            msgId: raw.id,
            peer: peer.peer,
            ...(peer.accessHash !== undefined ? { accessHash: peer.accessHash } : {}),
          })
        : '',
      sentAtMs: m.tsMs,
    };
    if (m.media.mimeType) file.mimeType = m.media.mimeType;
    file.filename = attachmentFilename(m.media);
    this.pendingFiles.push(file);
  }

  private recentIndexFor(chatId: string): Map<number, NormalizedMessage> {
    return (
      this.recent.get(chatId) ??
      this.recent.set(chatId, new Map()).get(chatId)!
    );
  }

  private remember(chatId: string, id: number, m: NormalizedMessage): void {
    const index = this.recentIndexFor(chatId);
    index.set(id, m);
    if (index.size > RECENT_INDEX_CAP) {
      const oldest = index.keys().next().value;
      if (oldest !== undefined) index.delete(oldest);
    }
  }

  private scheduleLiveFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const t = setTimeout(() => {
      void this.flush('live');
    }, this.deps.flushDebounceMs ?? FLUSH_DEBOUNCE_MS);
    (t as { unref?: () => void }).unref?.();
    this.flushTimer = t;
  }

  /** Serialized: merges every pending bucket against the stored ledger and
   *  pushes ONE batch (day items, then files) with a cursor snapshot. */
  private flush(phase: 'backfill' | 'live'): Promise<void> {
    this.flushChain = this.flushChain
      .then(() => this.doFlush(phase))
      .catch((err: unknown) => {
        // A failed doFlush throws before reaching buckets.clear(), so its
        // buckets stay pending and are retried by the next flush — nothing
        // is dropped. The chain must never stay rejected: stop()/fatal()
        // await it to close the queue and disconnect.
        this.deps.log('error', `telegram: flush failed — ${String(err)}`);
      });
    return this.flushChain;
  }

  private async doFlush(phase: 'backfill' | 'live'): Promise<void> {
    if (this.buckets.size === 0 && this.pendingFiles.length === 0) return;
    const days: TelegramItem[] = [];
    for (const [chatId, chatBuckets] of this.buckets) {
      for (const [day, bucket] of chatBuckets) {
        const incoming = [...bucket.byId.values()];
        const prior =
          (await this.deps.loadPriorMessages(`${chatId}:${day}`)) ?? [];
        days.push({
          kind: 'day',
          chat: bucket.chat,
          day,
          messages: mergeMessages(prior, incoming),
        });
      }
    }
    this.buckets.clear();
    const files = this.pendingFiles;
    this.pendingFiles = [];
    this.queue.push({
      phase,
      items: [...days, ...files],
      cursor: JSON.parse(JSON.stringify(this.cursor)) as TelegramCursor,
    });
  }

  private fatal(err: Error): void {
    if (isAuthLossError(err)) {
      this.loggedOut = true;
      this.deps.log('error', `telegram: session lost — ${err.message}`);
    } else {
      this.deps.log('error', `telegram: sync failed — ${err.message}`);
    }
    this.fatalError = err;
    this.walking = false;
    // Final flush of whatever is bucketed, then end the generator.
    void this.flush('backfill').then(() => this.queue.close());
  }
}
