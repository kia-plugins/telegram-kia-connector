/**
 * Telegram Sender — posts a reply into the chat a day document came from,
 * optionally quoting one of its messages. Reachable only from kiagent-core's
 * confirmation-gated send pipeline; the target is the opaque
 * `metadata.outbound` ref toDocument wrote (outbound.ts), never a
 * model-supplied chat.
 *
 * A FRESH short-lived client per send (the pattern fetchBytes uses), not the
 * pull's live client: its `floodSleepThreshold` is 0, so a FLOOD_WAIT is
 * reported at once instead of teleproto sleeping and sending minutes after
 * the host has already recorded the send as failed. One overall deadline
 * disconnects the client, which fails every pending request — nothing this
 * call started can still go out after it has thrown. (teleproto's own
 * resends inside that window reuse one `random_id`, so Telegram dedupes
 * them.)
 *
 * Failure wording is a cross-repo contract with kiagent-core's
 * error-copy.ts: `reconnect … in Settings` (auth), `rate-limited:` and
 * `not sent:` prove nothing left; anything else reads "may have been sent".
 */
import path from 'node:path';

import type {
  HostFor,
  SendIntent,
  SendResult,
  Sender,
} from '@kiagent/connector-sdk';

import { loadAuthBlob, type AuthBlob } from './auth';
import { makeTelegramClient, type TgClient } from './client';
import { inputPeerFor } from './media';
import { parseOutboundRef } from './outbound';
import { isAuthLossError } from './runtime';

/** Well inside kiagent-core's 60 s sender timeout (which does not cancel). */
export const SEND_DEADLINE_MS = 40_000;

const RECONNECT = 'your Telegram session is gone — reconnect the account in Settings';

export interface TelegramSenderSeams {
  makeClient?: (auth: AuthBlob, opts: { forSend: true }) => TgClient;
  deadlineMs?: number;
}

class DeadlineError extends Error {}
class ReconnectError extends Error {}

export function createTelegramSender(
  host: HostFor<'query'>,
  seams: TelegramSenderSeams = {},
): Sender {
  const makeClient = seams.makeClient ?? makeTelegramClient;
  const deadlineMs = seams.deadlineMs ?? SEND_DEADLINE_MS;

  return {
    async send(intent: SendIntent): Promise<SendResult> {
      const ref = parseOutboundRef(intent.outboundRef);
      if (!ref) throw new Error('not sent: this draft has no Telegram chat to reply to');

      // ONE deadline from entry: the account lookup is an RPC that can stall
      // too, and a send must never start after the caller has been told it
      // did not happen.
      let client: TgClient | undefined;
      let requested = false;
      let abandoned = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineError()), deadlineMs);
      });
      const work = (async () => {
        // The session lives in this extension's data dir, found through the
        // account's config (a pairing source keeps nothing in the host vault).
        const account = (await host.query.accounts()).find((a) => a.id === intent.accountId);
        const authFile = (account?.config as { authFile?: unknown } | undefined)?.authFile;
        if (typeof authFile !== 'string' || authFile.length === 0) throw new ReconnectError();
        const blob = loadAuthBlob(path.join(host.self.dataDir, authFile));
        if (!blob || blob.session.length === 0) throw new ReconnectError();
        if (abandoned) throw new DeadlineError();
        client = makeClient(blob, { forSend: true });
        await client.connect();
        // The deadline may have fired while connecting.
        if (abandoned) throw new DeadlineError();
        requested = true;
        return client.sendMessage(inputPeerFor(ref), {
          message: intent.bodyMarkdown,
          ...(ref.replyTo !== undefined ? { replyTo: ref.replyTo } : {}),
        });
      })();
      work.catch(() => {}); // settled below or abandoned at the deadline
      try {
        const sent = await Promise.race([work, deadline]);
        return sent?.id !== undefined ? { externalMessageId: String(sent.id) } : {};
      } catch (e) {
        throw sendError(e, requested);
      } finally {
        abandoned = true;
        clearTimeout(timer);
        // Also the deadline's cancellation: a disconnected sender fails every
        // request still pending, so nothing is sent after we return.
        await client?.disconnect().catch(() => {});
      }
    },
  };
}

function sendError(e: unknown, requested: boolean): Error {
  if (e instanceof DeadlineError)
    return requested
      ? new Error('Telegram did not confirm the message in time')
      : new Error("not sent: couldn't reach Telegram in time — try again");
  if (e instanceof ReconnectError || isAuthLossError(e)) return new Error(RECONNECT);
  const err = e as { code?: unknown; seconds?: unknown; message?: unknown };
  const text = String(err?.message ?? e);
  if (err?.code === 420)
    return new Error(
      `rate-limited: Telegram asked to wait ${Number(err.seconds) || 'a few'} s before sending — nothing was sent`,
    );
  // 400/403: Telegram refused the request itself (peer invalid, writing
  // forbidden, blocked…) — nothing was delivered.
  if (err?.code === 400 || err?.code === 403)
    return new Error(`not sent: Telegram refused the message — ${text}`);
  if (!requested) return new Error(`not sent: couldn't connect to Telegram — ${text}`);
  return e instanceof Error ? e : new Error(text);
}
