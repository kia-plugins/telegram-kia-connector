/**
 * The Telegram source: QR pairing in connect() (auth blob persisted under the
 * extension's dataDir — see the README privacy note on plaintext storage),
 * and a pull() that owns one long-lived teleproto client per account and never
 * returns while healthy: the resumable history walker streams 'backfill'
 * batches, live events stream 'live' batches, media bytes land as parented
 * `file` items. The engine drains the iterable with no per-batch timeout —
 * the open generator IS the realtime path.
 */
import path from 'node:path';

import { EditedMessage, NewMessage } from 'teleproto/events';

import { loadAuthBlob, saveAuthBlob, type AuthBlob } from './auth';
import { DOC_TYPE, dayTitle, renderDay } from './chat-day';
import { makeTelegramClient, type TgClient } from './client';
import type {
  AuthChannel,
  Batch,
  Document,
  DocumentInput,
  HostFor,
  Session,
  Source,
} from './kiagent-contracts';
import {
  extOf,
  FILE_DOC_TYPE,
  inputPeerFor,
  MEDIA_SIZE_CAP_BYTES,
  parseRef,
} from './media';
import { TelegramPullRuntime } from './runtime';
import type {
  NormalizedMessage,
  TelegramCursor,
  TelegramItem,
} from './types';

export type TelegramHost = HostFor<'net' | 'query'>;

export const PAIRING_TIMEOUT_MS = 180_000;

const NOT_PAIRED = 'telegram: not paired — reconnect the account';

/** Test seams — production callers omit all of these. */
export interface TelegramSourceSeams {
  makeClient?: (auth: AuthBlob) => TgClient;
  /** Event builder instances (teleproto NewMessage/EditedMessage by default). */
  events?: { newMessage: unknown; editedMessage: unknown };
  pairingTimeoutMs?: number;
  flushDebounceMs?: number;
  commitEvery?: number;
  catchUpOverlapMs?: number;
  mediaWindowMs?: number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const API_CREDS_SCHEMA = {
  type: 'object',
  required: ['apiId', 'apiHash'],
  description:
    'Telegram requires per-user API credentials for third-party clients. ' +
    'Create yours once (~2 minutes) at https://my.telegram.org → API development tools; any app title works.',
  properties: {
    apiId: { type: 'number', title: 'api_id', examples: ['123456'] },
    apiHash: {
      type: 'string',
      title: 'api_hash',
      format: 'password',
      description: 'The 32-character hash shown next to your api_id.',
    },
  },
};

function passwordSchema(hint?: string): Record<string, unknown> {
  return {
    type: 'object',
    required: ['password'],
    description: 'This account has two-step verification enabled.',
    properties: {
      password: {
        type: 'string',
        title: 'Two-step verification password',
        format: 'password',
        ...(hint ? { description: `Hint: ${hint}` } : {}),
      },
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    (t as { unref?: () => void }).unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export function createTelegramSource(
  host: TelegramHost,
  seams: TelegramSourceSeams = {},
): Source<TelegramCursor, TelegramItem> {
  const makeClient = seams.makeClient ?? makeTelegramClient;
  const events = seams.events ?? {
    newMessage: new NewMessage({}),
    editedMessage: new EditedMessage({}),
  };

  return {
    descriptor: {
      id: 'telegram',
      name: 'Telegram',
      documentTypes: [DOC_TYPE, FILE_DOC_TYPE],
      auth: 'pairing',
      multiAccount: true,
      cadence: { every: '15m' },
    },

    async connect(auth: AuthChannel) {
      const answers = await auth.prompt(API_CREDS_SCHEMA);
      const apiId = Number(answers.apiId);
      const apiHash =
        typeof answers.apiHash === 'string' ? answers.apiHash.trim() : '';
      if (!Number.isInteger(apiId) || apiId <= 0 || apiHash.length === 0) {
        throw new Error(
          'telegram: api_id and api_hash are required — create them at https://my.telegram.org',
        );
      }
      const client = makeClient({ apiId, apiHash, session: '' });
      auth.status('Connecting to Telegram…');
      await client.connect();
      try {
        // teleproto swallows the real failure and throws AUTH_USER_CANCEL when
        // onError returns true — capture it so the user sees the cause.
        let pairError: Error | null = null;
        try {
          await withTimeout(
            client.signInUserWithQrCode(
              { apiId, apiHash },
              {
                qrCode: async ({ token }) => {
                  // Status FIRST: the host UI clears any visible QR when a
                  // status arrives, so the QR must be the last event pushed.
                  auth.status(
                    'Scan with Telegram on your phone: Settings → Devices → Link Desktop Device',
                  );
                  auth.showQr(`tg://login?token=${token.toString('base64url')}`);
                },
                // teleproto drives the 2FA (SESSION_PASSWORD_NEEDED) flow through
                // this callback itself; onError only sees other failures.
                password: async (hint) => {
                  const a = await auth.prompt(passwordSchema(hint));
                  return typeof a.password === 'string' ? a.password : '';
                },
                onError: (err) => {
                  pairError = err;
                  return true; // stop the QR loop
                },
              },
            ),
            seams.pairingTimeoutMs ?? PAIRING_TIMEOUT_MS,
            'telegram pairing timed out — try again',
          );
        } catch (err) {
          throw pairError ?? err;
        }
        const me = await client.getMe();
        // Numeric user id: stable across phone-number changes, so re-pairing
        // upserts the same account and overwrites the blob (self-healing).
        const identifier = String(me.id);
        const authFile = `auth/${identifier}.json`;
        saveAuthBlob(path.join(host.self.dataDir, authFile), {
          apiId,
          apiHash,
          session: client.session.save(),
        });
        auth.status(
          `Linked ${me.firstName ?? me.username ?? identifier}. Syncing will start shortly.`,
        );
        return { identifier, config: { authFile } };
      } finally {
        try {
          await client.disconnect();
        } catch {
          /* already down */
        }
      }
    },

    async *pull(
      session: Session,
      cursor: TelegramCursor | null,
    ): AsyncGenerator<Batch<TelegramCursor, TelegramItem>> {
      const authFile = (session.account.config as { authFile?: unknown })
        ?.authFile;
      if (typeof authFile !== 'string' || authFile.length === 0) {
        throw new Error(NOT_PAIRED);
      }
      const blob = loadAuthBlob(
        path.join(host.self.dataDir, authFile),
        (m) => session.log('warn', m),
      );
      if (!blob || blob.session.length === 0) throw new Error(NOT_PAIRED);

      const runtime = new TelegramPullRuntime({
        client: makeClient(blob),
        initialCursor: cursor,
        events,
        loadPriorMessages: async (externalId) => {
          const doc = await host.query.byExternalId(
            session.account.id,
            externalId,
            DOC_TYPE,
          );
          const prior = (doc?.metadata as { messages?: unknown })?.messages;
          return Array.isArray(prior) ? (prior as NormalizedMessage[]) : null;
        },
        hasStoredFile: async (externalId) =>
          (await host.query.byExternalId(
            session.account.id,
            externalId,
            FILE_DOC_TYPE,
          )) !== null,
        log: (level, msg) => session.log(level, msg),
        nowMs: seams.nowMs,
        flushDebounceMs: seams.flushDebounceMs,
        commitEvery: seams.commitEvery,
        catchUpOverlapMs: seams.catchUpOverlapMs,
        mediaWindowMs: seams.mediaWindowMs,
        sleep: seams.sleep,
      });

      if (session.signal.aborted) return;
      // Abort → stop the client, final flush lands as the last batch(es),
      // queue closes, the drain loop below ends, generator returns.
      const onAbort = (): void => {
        void runtime.stop();
      };
      session.signal.addEventListener('abort', onAbort, { once: true });
      try {
        await runtime.start();
        for (;;) {
          const batch = await runtime.nextBatch();
          if (batch === null) break;
          yield batch;
        }
      } finally {
        session.signal.removeEventListener('abort', onAbort);
        await runtime.stop();
      }
      if (runtime.loggedOut) {
        // Auth error propagates (engine records lastError); shaped so
        // isAuthError()-style checks recognize it.
        const err = new Error(
          'telegram: logged out (401 unauthenticated) — reconnect the account',
        ) as Error & { status: number };
        err.status = 401;
        throw err;
      }
      if (runtime.fatalError) throw runtime.fatalError;
    },

    toDocument(item: TelegramItem): DocumentInput {
      if (item.kind === 'day') {
        const { chat, day, messages } = item;
        const last = messages[messages.length - 1];
        return {
          externalId: `${chat.chatId}:${day}`,
          type: DOC_TYPE,
          title: dayTitle(chat.name, day),
          markdown: renderDay(messages),
          url: `telegram://chat?id=${encodeURIComponent(chat.chatId)}`,
          metadata: {
            chat_key: chat.chatId,
            chat_key_kind: 'tg_chat_id',
            chat_type: chat.type,
            last_message_at: last ? new Date(last.tsMs).toISOString() : null,
            // Retained in full: the durable per-day ledger the next run
            // merges against (loadPriorMessages).
            messages,
          },
          createdAt: messages[0]
            ? new Date(messages[0].tsMs).toISOString()
            : null,
        };
      }
      // Deep-extraction handoff: the platform's vision/audio classifiers key
      // on metadata.mime / sizeBytes / filename / ext.
      const { filename } = item;
      const ext = filename !== undefined ? extOf(filename) : undefined;
      const metadata: Record<string, unknown> = {
        chat_key: item.chatId,
        sizeBytes: item.bytes.byteLength,
      };
      if (item.mimeType !== undefined) metadata.mime = item.mimeType;
      if (filename !== undefined) metadata.filename = filename;
      if (ext !== undefined) metadata.ext = ext;
      if (item.ref) metadata.tg_msg = item.ref;
      return {
        externalId: `${item.chatId}:${item.msgId}`,
        type: FILE_DOC_TYPE,
        title: filename ?? 'attachment',
        // null markdown + binary bytes: the ENGINE converts (parsers/OCR).
        markdown: null,
        binary: {
          bytes: item.bytes,
          mime: item.mimeType ?? 'application/octet-stream',
          ...(filename !== undefined ? { filename } : {}),
        },
        metadata,
        createdAt: new Date(item.sentAtMs).toISOString(),
        parent: { externalId: `${item.chatId}:${item.day}`, type: DOC_TYPE },
      };
    },

    /**
     * Deep-extraction byte path: rebuild the InputPeer from the self-contained
     * tg_msg ref (a fresh StringSession client has NO entity cache — never
     * getEntity() here), fetch the one message, download, disconnect. Unlike
     * WhatsApp's CDN refs, Telegram media does not expire — null is a real
     * failure or an over-cap file, not routine decay.
     */
    async fetchBytes(
      session: Session,
      doc: Document,
    ): Promise<Uint8Array | null> {
      const rawRef = (doc.metadata as { tg_msg?: unknown }).tg_msg;
      const ref = parseRef(rawRef);
      if (!ref) {
        if (rawRef !== undefined) {
          session.log(
            'warn',
            `telegram: unreadable tg_msg ref on ${doc.externalId} — cannot re-fetch media`,
          );
        }
        return null;
      }
      const authFile = (session.account.config as { authFile?: unknown })
        ?.authFile;
      if (typeof authFile !== 'string' || authFile.length === 0) return null;
      const blob = loadAuthBlob(path.join(host.self.dataDir, authFile));
      if (!blob) return null;
      const client = makeClient(blob);
      try {
        await client.connect();
        const [message] = await client.getMessages(inputPeerFor(ref), {
          ids: [ref.msgId],
        });
        if (!message) return null;
        const bytes = await client.downloadMedia(message, {});
        if (
          !Buffer.isBuffer(bytes) ||
          bytes.length === 0 ||
          bytes.length > MEDIA_SIZE_CAP_BYTES
        ) {
          return null;
        }
        return new Uint8Array(bytes);
      } catch (err) {
        session.log(
          'warn',
          `telegram: media re-fetch failed for ${doc.externalId} — ${String(err)}`,
        );
        return null;
      } finally {
        try {
          await client.disconnect();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
