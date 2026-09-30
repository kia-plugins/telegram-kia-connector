/**
 * The ONLY file that imports teleproto client machinery. Everything else talks
 * to TgClient — a narrow duck of the handful of methods this connector uses —
 * so tests run on plain fakes and a teleproto upgrade has one blast radius.
 */
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';

import type { AuthBlob } from './auth';

/** FLOOD_WAITs up to this many seconds are slept through by teleproto itself. */
export const FLOOD_SLEEP_THRESHOLD_S = 300;

export interface QrToken {
  token: Buffer;
  expires: number;
}

export interface QrSignInParams {
  qrCode: (t: QrToken) => Promise<void>;
  password?: (hint?: string) => Promise<string>;
  onError: (err: Error) => Promise<boolean> | boolean;
}

export interface TgClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getMe(): Promise<{
    id: unknown;
    firstName?: string | null;
    username?: string | null;
  }>;
  signInUserWithQrCode(
    creds: { apiId: number; apiHash: string },
    params: QrSignInParams,
  ): Promise<unknown>;
  iterDialogs(params: { ignoreMigrated?: boolean }): AsyncIterable<unknown>;
  iterMessages(
    entity: unknown,
    params: { offsetId?: number; limit?: number; waitTime?: number },
  ): AsyncIterable<unknown>;
  downloadMedia(
    message: unknown,
    opts?: Record<string, unknown>,
  ): Promise<Buffer | string | undefined>;
  getMessages(entity: unknown, params: { ids: number[] }): Promise<unknown[]>;
  sendMessage(
    entity: unknown,
    params: { message: string; replyTo?: number },
  ): Promise<{ id?: unknown }>;
  addEventHandler(
    cb: (event: unknown) => void | Promise<void>,
    event: unknown,
  ): void;
  session: { save(): string };
}

/** `forSend`: the Sender's one-shot client. FLOOD_WAIT surfaces at once
 *  (threshold 0) instead of teleproto sleeping and sending past the host's
 *  send timeout; ONE request attempt and no auto-reconnect, so a request
 *  that may already have reached Telegram is never re-sent (a later refusal
 *  must not be read as "nothing was sent"). */
export function makeTelegramClient(auth: AuthBlob, opts: { forSend?: boolean } = {}): TgClient {
  const client = new TelegramClient(
    new StringSession(auth.session),
    auth.apiId,
    auth.apiHash,
    {
      connectionRetries: 5,
      autoReconnect: !opts.forSend,
      ...(opts.forSend ? { requestRetries: 1 } : {}),
      floodSleepThreshold: opts.forSend ? 0 : FLOOD_SLEEP_THRESHOLD_S,
      deviceModel: 'KIAgent',
    },
  );
  return client as unknown as TgClient;
}
