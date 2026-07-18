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
  addEventHandler(
    cb: (event: unknown) => void | Promise<void>,
    event: unknown,
  ): void;
  session: { save(): string };
}

export function makeTelegramClient(auth: AuthBlob): TgClient {
  const client = new TelegramClient(
    new StringSession(auth.session),
    auth.apiId,
    auth.apiHash,
    {
      connectionRetries: 5,
      autoReconnect: true,
      floodSleepThreshold: FLOOD_SLEEP_THRESHOLD_S,
      deviceModel: 'KIAgent',
    },
  );
  return client as unknown as TgClient;
}
