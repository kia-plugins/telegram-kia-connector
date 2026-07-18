# Telegram connector for KIAgent

A Telegram connector for KIAgent (extension platform). It signs in to your
Telegram account as a third-party client through the official MTProto API
(via [teleproto](https://github.com/sanyok12345/teleproto), the maintained
fork of GramJS) and ingests your DMs and
group chats — one searchable document per chat per day, plus downloaded
media — into your local KIAgent digital memory.

Unlike WhatsApp, Telegram officially supports third-party clients: you
register your own API credentials and the connector logs in as a linked
device you can see and revoke at any time (Settings → Devices).

## ⚠️ Before you connect

- **Account flagging:** a fresh login from an unfamiliar client can trigger
  Telegram's anti-abuse checks — you'll get a login-notification message,
  and very new accounts can in rare cases be temporarily limited. The
  connector keeps its traffic gentle (one connection, paced history reads,
  one media download at a time), which reduces but does not eliminate this.
- **Secret chats never appear.** They are end-to-end encrypted to specific
  devices and are invisible to any new client by design.
- **Session storage is plaintext.** Your `api_hash` and login session are
  stored unencrypted in the extension's private data directory. Anyone with
  that file can read your account until you revoke the session from
  Telegram → Settings → Devices → terminate.

## Install

Install **Telegram** from the KIAgent marketplace. KIAgent prompts for the
two grants this connector needs:

- `net` — the connector talks to Telegram's servers over teleproto's own
  connection.
- `query` — it re-reads its own previously-ingested chat-day documents so
  new messages merge into existing days across restarts.

## Connect your account

1. **Get API credentials** (once, ~2 minutes): log in at
   [my.telegram.org](https://my.telegram.org) → *API development tools* →
   create an app (any title). Copy the numeric `api_id` and the `api_hash`.
2. Add a Telegram account in KIAgent and paste both values when prompted.
3. A QR code appears. On your phone: **Telegram → Settings → Devices →
   Link Desktop Device**, then scan. If your account has two-step
   verification, KIAgent asks for that password once.
4. Done. The account identifier is your numeric Telegram user id; pairing
   times out after ~3 minutes — just try again. Re-pairing later reuses the
   same account and refreshes its session.

## What gets indexed

- **One document per chat per (local) day** — type `telegram.chat_day`,
  externalId `<chatId>:<YYYY-MM-DD>` — with every message rendered as
  `HH:MM Sender: text`, media as labels (`[image]`, `[voice note 1:05]`,
  `[document: report.pdf]`), forwards prefixed `fwd from …`, and service
  notices in italics. Reply quotes render inline (`↳re …`) for messages
  received during the live phase; quotes resolve against an in-memory
  recent-message index only, so replies rendered during the historical
  backfill show no quoted snippet.
- **Which chats:** DMs (including Saved Messages) and groups (basic +
  supergroups). Broadcast channels, bot chats, and Telegram's service
  notifications are skipped.
- **Full history.** The first sync walks every included chat back to
  message #1 — recent chats first, resumable at any point, and it can take
  hours on an old account. Telegram rate limits (FLOOD_WAIT) are expected
  during this walk; the connector sleeps them out and continues.
- **Media files** (photos, videos, voice notes, documents, stickers) up to
  **25 MiB** land as `telegram.file` documents parented to their chat-day,
  ready for KIAgent's OCR / transcription. During the historical backfill,
  media bytes are fetched only for the last **180 days** (older messages
  keep their text label); everything from the live phase onward is fetched.
  Media can always be re-fetched later — Telegram media does not expire.
- **Live messages** stream in continuously while KIAgent runs; edits
  overwrite the original in place.

## Development

```bash
npm install
npm test          # jest unit + bundle-load suites
npm run typecheck
npm run build     # esbuild → dist/index.js
```

`src/kiagent-contracts.ts` is a vendored snapshot of the KIAgent platform
contract — do not edit it here.

## License

MIT — see `LICENSE`. Not affiliated with Telegram FZ-LLC.
