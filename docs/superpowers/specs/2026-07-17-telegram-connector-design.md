# Telegram Connector for KIAgent — Design

**Date:** 2026-07-17
**Status:** Approved
**Repo:** `kia-plugins/telegram-kia-connector` (new)

## Overview

A KIAgent extension-platform connector that indexes a user's Telegram chats
into local KIAgent memory. It links to the user's account as an MTProto
client via [GramJS](https://github.com/gram-js/gramjs) (the `telegram` npm
package), backfills **full history** of DMs and groups, then streams live
messages over a long-lived connection — the WhatsApp-connector architecture
applied to Telegram.

Decisions locked during brainstorming:

| Decision | Choice |
|---|---|
| API credentials | **User-provided** `api_id`/`api_hash` from my.telegram.org (no bundled pair) |
| Chat scope | **DMs + groups** (basic + supergroups). No broadcast channels, no bot chats |
| History depth | **Full history** — walk every included chat to message #1, resumably |
| Sync model | **Live client** — `pull()` owns one long-lived GramJS client; open generator is the realtime path |

## Non-goals (v1)

- Broadcast channels, bot chats, secret chats (secret chats are not visible
  to MTProto clients by design).
- Deletion reconciliation (no `reconcile()`).
- Rich rendering of reactions, polls, games — they render as plain-text
  labels.
- Encrypted-at-rest session storage (plaintext under `dataDir`, same as the
  WhatsApp connector, with the same README privacy note).

## Repo shape

Mirror `whatsapp-kia-connector` exactly:

```
telegram-kia-connector/
  manifest.json          # id kia.telegram, engine ^1.0.0, caps [net, query]
  package.json           # dep: telegram (GramJS); dev: esbuild/jest/ts-jest/tsc
  build.mjs              # esbuild → dist/index.js, CJS, node20, bundled
  tsconfig.json
  jest.config.js
  icon.png               # ≤200KB paper-plane mark
  LICENSE                # MIT
  README.md              # setup steps + unofficial-client / ToS risk note
  src/
    kiagent-contracts.ts # vendored §7 snapshot (copied from whatsapp connector)
    index.ts             # ExtensionModule: activate → { sources: [source] }
    source.ts            # descriptor + connect + pull + toDocument + fetchBytes
    auth.ts              # session-file load/save (StringSession + api creds)
    client.ts            # GramJS client factory (seam for tests)
    dialogs.ts           # dialog listing + include/exclude filtering
    walker.ts            # unified backfill/catch-up history walker
    live.ts              # NewMessage/EditedMessage buffering + debounce flush
    messages.ts          # raw Api.Message → NormalizedMessage
    chat-day.ts          # dayKey/mergeMessages/renderDay/dayTitle (WhatsApp pattern)
    media.ts             # media descriptors, size caps, download, tg_msg refs
    queue.ts             # async batch queue (WhatsApp pattern)
    runtime.ts           # TelegramPullRuntime orchestrating the above
    types.ts             # NormalizedMessage, TelegramCursor, items
    __tests__/           # unit tests + bundle-load smoke test
```

**Manifest:**

```json
{
  "id": "kia.telegram",
  "name": "Telegram",
  "version": "1.0.0",
  "engine": "^1.0.0",
  "entry": "dist/index.js",
  "caps": ["net", "query"],
  "contributes": { "sources": ["telegram"] },
  "icon": "icon.png"
}
```

**Descriptor:** `id: 'telegram'`, `auth: 'pairing'`, `multiAccount: true`,
`cadence: { every: '15m' }` (watchdog restart, not the sync driver),
`documentTypes: ['telegram.chat_day', 'telegram.file']`.

## Auth — `connect(auth)`

1. `auth.prompt()` a form for `api_id` (number) and `api_hash` (string),
   with instructions: my.telegram.org → API development tools → create an
   app. `auth.status()` explains why (Telegram requires per-user client
   credentials; this is a 2-minute one-time step).
2. Create a GramJS client with a fresh `StringSession`. Run
   `client.signInUserWithQrCode`:
   - each rotated token → `auth.showQr('tg://login?token=<base64url>')`;
     user scans from Telegram mobile: Settings → Devices → Link Desktop
     Device.
   - `password:` callback (2FA cloud password) → one more `auth.prompt()`.
3. On success read `me` (`client.getMe()`):
   - `identifier = String(me.id)` — stable across phone-number changes, so
     re-pairing upserts the same account and overwrites the session blob
     (self-healing re-auth, same as WhatsApp).
4. Persist `{ apiId, apiHash, session: stringSession.save() }` as JSON to
   `dataDir/auth/<identifier>.json`. Return
   `{ identifier, config: { authFile } }`.

Pairing timeout: 180s overall, mirroring `PAIRING_TIMEOUT_MS`.

## Sync — `pull(session, cursor)`

`TelegramPullRuntime` (analog of `WhatsAppPullRuntime`): owns one client,
an async batch queue, and a day-bucket buffer with debounce flush. The
generator yields batches from the queue and never returns while healthy.

### Dialog filtering (`dialogs.ts`)

Include: user DMs (`isUser`, excluding bots via `user.bot` and service
accounts — id 777000), Saved Messages (self-chat — it's personal notes),
basic groups, and supergroups (`megagroup === true`). Exclude: broadcast
channels (`broadcast === true`), bots.

### The walker (`walker.ts`) — unified backfill + catch-up

One mechanism serves both first-run full-history backfill and
between-run catch-up. Per-chat cursor state:

```ts
interface ChatProgress {
  /** Oldest message id already ingested (walk continues below it). */
  oldestId?: number;
  /** True once the walk reached message #1. */
  complete: boolean;
  /** Newest message timestamp (ms) seen — the catch-up watermark. */
  newestTsMs: number;
}
interface TelegramCursor {
  chats: Record<string, ChatProgress>; // key: String(chatId)
}
```

On every `pull()` run, for each included dialog, walk
`iterMessages(chat, { offsetId })` newest → oldest:

- **New/incomplete chat** (`!complete`): walk from `oldestId` (or the top)
  all the way down to message #1, yielding day-batches as buckets fill;
  update `oldestId` with every committed batch so an interrupted
  hours-long first sync resumes exactly where it stopped.
- **Complete chat**: walk from the top down only until messages older than
  `newestTsMs` (minus a small overlap) — that's the offline-gap catch-up.
  Day-merge idempotency makes overlap harmless.

Chats are walked sequentially (recent-activity dialogs first) so recent
context lands in memory first; live events for *any* chat interleave
concurrently.

### Live phase (`live.ts`)

Event handlers are attached **before** the walker starts, so nothing sent
during a long backfill is missed (dedup by message id absorbs overlap):

- `NewMessage` → normalize, bucket into (chat, local-day), debounce-flush
  (~3s quiet) into a day-batch merged against the prior ledger.
- `EditedMessage` → same path; `mergeMessages` "incoming wins by id"
  handles the rewrite.

Day-doc merge discipline is identical to WhatsApp: before flushing a day
bucket, load the prior ledger via
`host.query.byExternalId(accountId, externalId, DOC_TYPE)` and merge.

### Rate limits & errors

- Client constructed with `floodSleepThreshold: 300` — GramJS auto-sleeps
  short FLOOD_WAITs. Longer waits: log at `warn`, sleep, continue — with
  full-history backfill this is expected operation, not an error.
- Connection drops: GramJS `connectionRetries` plus runtime
  reconnect-with-backoff, mirroring the WhatsApp runtime.
- Auth loss (`AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`,
  `USER_DEACTIVATED`): throw an `Error` with `status = 401` after final
  flush, so the engine marks the account reconnect-needed.
- Abort: `session.signal` → stop walker, disconnect client, final flush
  lands as the last batch(es), generator returns.

## Document model

Same two-type model as WhatsApp.

**Chat-day docs** — `type: 'telegram.chat_day'`:
- `externalId: ${chatId}:${YYYY-MM-DD}` (local-calendar day key)
- `title: '<chatName> — Mon D, YYYY'`
- `markdown`: rendered transcript (`hh:mm Sender: text`, `_system_` lines,
  `↳re` quotes, `[photo]`/`[voice note m:ss]`/`[document: name]` media
  labels, `fwd from X:` prefix for forwards)
- `metadata`: `chat_key` (String(chatId)), `chat_type` (`dm`|`group`),
  `last_message_at`, and the full `messages` ledger (the merge substrate)
- `url: telegram://chat?id=<chatId>` (opaque locator, WhatsApp convention)

**File docs** — `type: 'telegram.file'`, parented to their day doc:
- Media kinds: photo, video, audio/voice, document, sticker; captions stay
  in the transcript.
- Size cap: same constant value as the WhatsApp connector's
  `MEDIA_SIZE_CAP_BYTES`.
- **Media backfill window:** inline bytes are downloaded only for messages
  newer than `MEDIA_BACKFILL_WINDOW` (default 180 days) plus everything in
  the live phase. Older media appears in transcripts as labels only — this
  keeps full-*text* history complete while bounding a full-history sync's
  byte volume and flood exposure. Tunable constant.
- `metadata.tg_msg = '<chatId>:<msgId>'` — the re-fetch ref.
- `binary.bytes` inline for the platform's OCR/vision/transcription.

**`fetchBytes`** — deep extraction re-fetch: parse `tg_msg`, spin up a
short-lived client from the auth file, `getMessages(chat, { ids })`,
`downloadMedia`, disconnect. Telegram media does not expire, so unlike
WhatsApp this path is reliable long-term. Null (never throw) on any
failure or over-cap.

## Message normalization (`messages.ts`)

`Api.Message` → `NormalizedMessage` (same shape as WhatsApp's `types.ts`):
id (String(msg.id)), tsMs (`msg.date * 1000`), sender display name
(entity cache: first + last name, else username, else phone; null for
service messages), text (`msg.message`, caption for media), media
descriptor, quote (reply-to snippet via `msg.getReplyMessage()`, capped
snippet length), `system: true` for `MessageService` (joins, pins, calls —
rendered via GramJS action text or a generic label). Forwarded messages
prefix text with `fwd from <name>: `.

## Testing

Seams mirror the WhatsApp connector: a client-factory seam injects a fake
GramJS client; all timing constants injectable.

- `connect` flow: prompt for creds → QR rotation → 2FA prompt path →
  session file written, identifier correct.
- Dialog filtering: users/bots/channels/megagroups/Saved Messages matrix.
- Walker: full backfill to #1; resume from mid-chat cursor; catch-up stop
  at watermark; sequential chat ordering.
- Live: buffering, debounce flush, edit re-merge, backfill/live overlap
  dedup.
- chat-day: dayKey/merge/render golden tests.
- Media: caps, backfill window, tg_msg refs, `fetchBytes` null paths.
- Runtime: abort mid-backfill (cursor intact), 401-shaped auth-loss throw,
  flood-wait sleep path.
- Bundle-load smoke test: esbuild output `require()`s cleanly and
  `activate()` returns one source (catches GramJS bundling surprises).

## Risks

- **Account flagging:** logging in as an MTProto client from a new device
  can trigger Telegram's anti-abuse checks (login notification, rarely a
  temporary block on very new accounts). README documents this plainly, as
  the WhatsApp README does its ban risk. User-provided api_id/api_hash
  keeps blast radius per-user.
- **GramJS bundling:** the `telegram` package is large and CJS; esbuild
  bundling is expected to work but the bundle-load smoke test is the
  gate. Fallback if bundling fails: mark the package external and ship it
  inside the tarball alongside `dist/`.
- **Full-history duration:** hours on old accounts; mitigated by
  resumable per-chat cursors, recent-first ordering, and the media
  window.
