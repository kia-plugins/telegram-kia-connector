# Telegram Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `telegram-kia-connector` — a KIAgent extension-platform connector that QR-links a Telegram account via GramJS, backfills full chat history (DMs + groups) resumably, then streams live messages, producing chat-day documents and media file documents.

**Architecture:** Mirror of `whatsapp-kia-connector`: `pull()` owns one long-lived GramJS client per account; a resumable per-chat history **walker** plus live event handlers both feed day-buckets in a `TelegramPullRuntime`, which flushes merged chat-day batches through an `AsyncBatchQueue` that the open `pull()` generator drains. `connect()` prompts for user-provided `api_id`/`api_hash` then QR-signs-in.

**Tech Stack:** TypeScript (strict, CJS), GramJS (`telegram@2.26.22`), esbuild single-file bundle, Jest + ts-jest.

**Spec:** `docs/superpowers/specs/2026-07-17-telegram-connector-design.md`. Two deliberate refinements vs the spec's file list: live event handling lives inside `runtime.ts` (a separate `live.ts` wasn't pulling its weight — same day-bucket structure as the walker path), and reply-quotes resolve against an in-memory per-chat recent-message index (no extra API calls per message).

## Global Constraints

- Repo root: `/Users/edjafarov/work/telegram-kia-connector` (git repo already initialized; spec + this plan are committed).
- Node 20+, TypeScript strict, CommonJS modules; production artifact is ONE esbuild CJS bundle `dist/index.js`.
- Dependency: exactly `telegram@2.26.22` (pin it). Dev deps only beyond that.
- Vendored platform contract: `src/kiagent-contracts.ts` — copied verbatim from `whatsapp-kia-connector`, NEVER edited.
- Doc types: `'telegram.chat_day'` and `'telegram.file'`. Caps: `["net", "query"]` — nothing else.
- Manifest id `kia.telegram`, source id `telegram`, engine `^1.0.0`.
- Media caps: `MEDIA_SIZE_CAP_BYTES = 25 * 1024 * 1024`; backfill media window `MEDIA_BACKFILL_WINDOW_MS = 180 days`.
- GramJS facts (verified against 2.26.22 typings — do not "fix" them):
  - `new TelegramClient(new StringSession(str), apiId, apiHash, opts)`; `StringSession` from `'telegram/sessions'`.
  - `client.signInUserWithQrCode({ apiId, apiHash }, { qrCode: async ({token, expires}) => {}, password?: async (hint) => string, onError: (err) => boolean|Promise<boolean> })`.
  - QR deep link is `'tg://login?token=' + token.toString('base64url')`.
  - `client.iterMessages(entity, { offsetId, waitTime })` walks newest→oldest; `offsetId` is EXCLUSIVE (only strictly older messages come back).
  - `NewMessage` is exported from `'telegram/events'`; `EditedMessage` is NOT — import it from `'telegram/events/EditedMessage'`.
  - `Api.Message.date` is epoch SECONDS.
- TDD every task: failing test → run → implement → pass → commit. Run tests with `npx jest <path> -v` from repo root. Commit after every task with the message given in the task; end every commit message with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Reference repo (read-only pattern source): a clone of `whatsapp-kia-connector` exists at
  `/private/tmp/claude-501/-Users-edjafarov-work-kiagent-core/ab43d0e5-c43a-456e-8a0f-c684e21a81f7/scratchpad/whatsapp-kia-connector`.
  If that path is gone: `git clone --depth 1 https://github.com/kia-plugins/whatsapp-kia-connector /tmp/wkc` and substitute `/tmp/wkc`.

---

### Task 1: Repo scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `jest.config.js`, `build.mjs`, `.gitignore`, `manifest.json`, `scripts/gen-icon.mjs`, `icon.png` (generated), `LICENSE` (copied), `src/kiagent-contracts.ts` (copied)

**Interfaces:**
- Consumes: nothing.
- Produces: the toolchain every later task runs (`npx jest`, `npx tsc --noEmit`), and `src/kiagent-contracts.ts` — the platform contract all source files import types from (`Source`, `Batch`, `Session`, `AuthChannel`, `HostFor`, `ExtensionModule`, `DocumentInput`, `Document`).

- [ ] **Step 1: Write config files**

`package.json`:

```json
{
  "name": "telegram-kia-connector",
  "version": "1.0.0",
  "description": "Telegram connector for KIAgent (extension platform, GramJS-based).",
  "license": "MIT",
  "private": false,
  "files": ["manifest.json", "dist", "README.md", "icon.png"],
  "scripts": {
    "build": "node build.mjs",
    "test": "jest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "telegram": "2.26.22"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.11.0",
    "esbuild": "0.23.1",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.2",
    "typescript": "^5.4.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "module": "commonjs",
    "target": "es2022",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["jest", "node"]
  },
  "include": ["src"]
}
```

`jest.config.js` (GramJS is CJS — no ESM transformer needed, unlike the WhatsApp connector):

```js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { diagnostics: false }],
  },
};
```

`build.mjs`:

```js
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/index.js',
  // Optional native ws accelerators GramJS's websocket dep probes for.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});
console.log('bundled dist/index.js');
```

`.gitignore`:

```
node_modules/
dist/
coverage/
```

`manifest.json`:

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

- [ ] **Step 2: Copy vendored contract + LICENSE from the WhatsApp connector clone**

```bash
cd /Users/edjafarov/work/telegram-kia-connector
mkdir -p src
WKC=/private/tmp/claude-501/-Users-edjafarov-work-kiagent-core/ab43d0e5-c43a-456e-8a0f-c684e21a81f7/scratchpad/whatsapp-kia-connector
cp "$WKC/src/kiagent-contracts.ts" src/kiagent-contracts.ts
cp "$WKC/LICENSE" LICENSE
```

Expected: both files exist; `head -5 src/kiagent-contracts.ts` shows the contract header comment.

- [ ] **Step 3: Generate the icon**

`scripts/gen-icon.mjs` — deterministic 256×256 PNG, Telegram-blue disc with a white paper-plane, no image libraries:

```js
// Writes icon.png: 256x256 RGBA, blue circle + white paper plane.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 256, H = 256;
const BLUE = [42, 171, 238, 255], WHITE = [255, 255, 255, 255], NONE = [0, 0, 0, 0];

// Point-in-triangle via sign of cross products.
function inTri(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Paper-plane: big triangle + fold triangle (classic Telegram silhouette).
const BODY = [[70, 128], [196, 74], [150, 186]];
const FOLD = [[110, 146], [150, 186], [116, 172]];

const rows = [];
for (let y = 0; y < H; y++) {
  const row = Buffer.alloc(1 + W * 4); // filter byte 0 + RGBA
  for (let x = 0; x < W; x++) {
    const dx = x - 128, dy = y - 128;
    let px = NONE;
    if (dx * dx + dy * dy <= 120 * 120) {
      px = inTri(x, y, ...BODY) && !inTri(x, y, ...FOLD) ? WHITE : BLUE;
    }
    row.set(px, 1 + x * 4);
  }
  rows.push(row);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../icon.png', import.meta.url), png);
console.log(`icon.png ${png.length} bytes`);
```

Run: `node scripts/gen-icon.mjs`
Expected: `icon.png <N> bytes` with N well under 204800 (the platform's 200KB cap). Verify: `file icon.png` → `PNG image data, 256 x 256`.

- [ ] **Step 4: Install and typecheck**

```bash
npm install
npx tsc --noEmit
```

Expected: install succeeds; typecheck passes (only `src/kiagent-contracts.ts` exists — it must compile clean untouched).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold telegram-kia-connector (toolchain, manifest, vendored contracts, icon)"
```

---

### Task 2: `types.ts` + `chat-day.ts` (pure day-document core)

**Files:**
- Create: `src/types.ts`, `src/chat-day.ts`
- Test: `src/__tests__/chat-day.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by every later task):
  - `NormalizedMessage { id: string; tsMs: number; sender: string | null; text: string; media?: MediaDescriptor; quote?: { sender: string | null; snippet: string }; system: boolean }`
  - `MediaKind = 'image'|'video'|'audio'|'document'|'sticker'`; `MediaDescriptor { kind: MediaKind; filename?: string; mimeType?: string; durationSec?: number }`
  - `ChatInfo { chatId: string; name: string; type: 'dm'|'group' }`
  - `ChatProgress { oldestId?: number; complete: boolean; newestTsMs: number }`; `TelegramCursor { chats: Record<string, ChatProgress> }`
  - `DayItem { kind: 'day'; chat: ChatInfo; day: string; messages: NormalizedMessage[] }`
  - `FileItem { kind: 'file'; chatId: string; day: string; msgId: string; bytes: Uint8Array; mediaKind: MediaKind; ref: string; mimeType?: string; filename?: string; sentAtMs: number }`
  - `TelegramItem = DayItem | FileItem`
  - chat-day: `DOC_TYPE = 'telegram.chat_day'`, `dayKey(tsMs): string`, `mergeMessages(existing, incoming): NormalizedMessage[]`, `renderDay(messages): string`, `dayTitle(chatName, key): string`

- [ ] **Step 1: Write the failing test**

`src/__tests__/chat-day.test.ts`:

```ts
import {
  DOC_TYPE,
  dayKey,
  dayTitle,
  mergeMessages,
  renderDay,
} from '../chat-day';
import type { NormalizedMessage } from '../types';

const msg = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: '1',
  tsMs: Date.UTC(2026, 6, 17, 10, 30),
  sender: 'Alice',
  text: 'hi',
  system: false,
  ...over,
});

describe('chat-day', () => {
  it('exposes the telegram day doc type', () => {
    expect(DOC_TYPE).toBe('telegram.chat_day');
  });

  it('dayKey uses the local calendar day', () => {
    const ts = new Date(2026, 6, 17, 23, 59).getTime(); // local
    expect(dayKey(ts)).toBe('2026-07-17');
  });

  it('dayTitle formats from the key', () => {
    expect(dayTitle('Alice', '2026-07-17')).toBe('Alice — Jul 17, 2026');
  });

  it('merge dedups by id, incoming wins, sorted by ts then id', () => {
    const existing = [msg({ id: 'a', tsMs: 1000, text: 'old' })];
    const incoming = [
      msg({ id: 'a', tsMs: 1000, text: 'edited' }),
      msg({ id: 'b', tsMs: 500 }),
    ];
    const merged = mergeMessages(existing, incoming);
    expect(merged.map((m) => m.id)).toEqual(['b', 'a']);
    expect(merged[1].text).toBe('edited');
  });

  it('renders senders, quotes, media labels and system lines', () => {
    const ts = new Date(2026, 6, 17, 9, 5).getTime();
    const out = renderDay([
      msg({ id: '1', tsMs: ts, text: 'hello' }),
      msg({
        id: '2',
        tsMs: ts,
        sender: 'Bob',
        text: 'yo',
        quote: { sender: 'Alice', snippet: 'hello' },
      }),
      msg({
        id: '3',
        tsMs: ts,
        text: '',
        media: { kind: 'audio', durationSec: 65 },
      }),
      msg({
        id: '4',
        tsMs: ts,
        text: '',
        media: { kind: 'document', filename: 'invoice.pdf' },
      }),
      msg({ id: '5', tsMs: ts, sender: null, text: 'Bob joined', system: true }),
    ]);
    expect(out).toBe(
      [
        '09:05 Alice: hello',
        '09:05 Bob: ↳re Alice: hello yo',
        '09:05 Alice: [voice note 1:05]',
        '09:05 Alice: [document: invoice.pdf]',
        '_Bob joined_',
      ].join('\n'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/chat-day.test.ts -v`
Expected: FAIL — cannot find module `../chat-day`.

- [ ] **Step 3: Write the implementation**

`src/types.ts`:

```ts
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
  /** Marked Telegram chat id (GramJS Dialog.id) as a string. */
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
```

`src/chat-day.ts` — the WhatsApp connector's file with the Telegram doc type (pattern-proven; keep identical apart from `DOC_TYPE`):

```ts
import type { MediaDescriptor, NormalizedMessage } from './types';

export const DOC_TYPE = 'telegram.chat_day';

/** Local-calendar day key 'YYYY-MM-DD' for an epoch-ms timestamp. */
export function dayKey(tsMs: number): string {
  const d = new Date(tsMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Union of existing + incoming messages, deduped by id, ascending by ts. */
export function mergeMessages(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  const byId = new Map<string, NormalizedMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m); // incoming wins on conflict
  return [...byId.values()].sort(
    (a, b) => a.tsMs - b.tsMs || a.id.localeCompare(b.id),
  );
}

function hhmm(tsMs: number): string {
  const d = new Date(tsMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

function mediaLabel(media: MediaDescriptor): string {
  if (media.kind === 'audio' && media.durationSec) {
    const mm = Math.floor(media.durationSec / 60);
    const ss = String(Math.floor(media.durationSec % 60)).padStart(2, '0');
    return `[voice note ${mm}:${ss}]`;
  }
  if (media.kind === 'document')
    return `[document: ${media.filename ?? 'file'}]`;
  return `[${media.kind}]`;
}

/**
 * Render the day's messages to markdown. Media renders as its label only —
 * navigation to the bytes is the `file` document's parent edge onto this day.
 */
export function renderDay(messages: NormalizedMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.system) {
      lines.push(`_${m.text}_`);
      continue;
    }
    const parts: string[] = [`${hhmm(m.tsMs)} ${m.sender ?? '?'}:`];
    if (m.quote) parts.push(`↳re ${m.quote.sender ?? '?'}: ${m.quote.snippet}`);
    if (m.media) parts.push(mediaLabel(m.media));
    if (m.text) parts.push(m.text);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** '<chatName> — Mon D, YYYY' for a 'YYYY-MM-DD' day key. */
export function dayTitle(chatName: string, key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return `${chatName} — ${MONTHS[m - 1]} ${d}, ${y}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/chat-day.test.ts -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/chat-day.ts src/__tests__/chat-day.test.ts
git commit -m "feat: day-document core — normalized message types, merge, render"
```

---

### Task 3: `queue.ts` (push→pull adapter)

**Files:**
- Create: `src/queue.ts`
- Test: `src/__tests__/queue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AsyncBatchQueue<T>` with `push(item: T): void`, `close(): void`, `get closed: boolean`, `next(): Promise<T | null>` (FIFO; parks until an item arrives; resolves `null` once closed AND drained). Used by `runtime.ts` (producer) and `source.ts` `pull()` (consumer).

- [ ] **Step 1: Write the failing test**

`src/__tests__/queue.test.ts`:

```ts
import { AsyncBatchQueue } from '../queue';

describe('AsyncBatchQueue', () => {
  it('delivers pushed items in FIFO order', async () => {
    const q = new AsyncBatchQueue<number>();
    q.push(1);
    q.push(2);
    expect(await q.next()).toBe(1);
    expect(await q.next()).toBe(2);
  });

  it('parks next() until an item arrives', async () => {
    const q = new AsyncBatchQueue<string>();
    const pending = q.next();
    q.push('late');
    expect(await pending).toBe('late');
  });

  it('drains queued items then yields null after close', async () => {
    const q = new AsyncBatchQueue<number>();
    q.push(1);
    q.close();
    expect(await q.next()).toBe(1);
    expect(await q.next()).toBeNull();
  });

  it('close wakes a parked consumer; pushes after close are dropped', async () => {
    const q = new AsyncBatchQueue<number>();
    const pending = q.next();
    q.close();
    expect(await pending).toBeNull();
    q.push(9);
    expect(await q.next()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/queue.test.ts -v`
Expected: FAIL — cannot find module `../queue`.

- [ ] **Step 3: Write the implementation**

`src/queue.ts` — verbatim from the WhatsApp connector (single-consumer by design; `pull()` is the only reader):

```ts
/**
 * The push→pull adapter at the heart of pull(): client events PUSH batches in,
 * the async generator PULLs them out. Single-consumer by design — pull() is
 * the only reader, so one parked waiter is enough.
 */
export class AsyncBatchQueue<T> {
  private items: T[] = [];

  private waiter: (() => void) | null = null;

  private closedFlag = false;

  /** Enqueue and wake the parked consumer. Dropped silently after close(). */
  push(item: T): void {
    if (this.closedFlag) return;
    this.items.push(item);
    this.wake();
  }

  /**
   * No more pushes will be accepted; the consumer drains what is queued and
   * then receives null. Idempotent. Wakes a parked consumer so shutdown is
   * prompt even when the queue is empty.
   */
  close(): void {
    this.closedFlag = true;
    this.wake();
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /**
   * Next queued item in FIFO order; parks until one arrives. Resolves null
   * once the queue is closed AND drained.
   */
  async next(): Promise<T | null> {
    for (;;) {
      if (this.items.length > 0) return this.items.shift()!;
      if (this.closedFlag) return null;
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/queue.test.ts -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/queue.ts src/__tests__/queue.test.ts
git commit -m "feat: async batch queue (push-to-pull adapter for the open generator)"
```

---

### Task 4: `media.ts` (descriptors, refs, caps, download)

**Files:**
- Create: `src/media.ts`
- Test: `src/__tests__/media.test.ts`

**Interfaces:**
- Consumes: `MediaDescriptor`, `MediaKind` from `./types`.
- Produces (used by `messages.ts`, `runtime.ts`, `source.ts`):
  - `FILE_DOC_TYPE = 'telegram.file'`, `MEDIA_SIZE_CAP_BYTES = 25 * 1024 * 1024`, `MEDIA_BACKFILL_WINDOW_MS = 180 * 24 * 60 * 60 * 1000`
  - `describeMedia(media: unknown): MediaDescriptor | undefined` — duck-typed over GramJS `Api.TypeMessageMedia`
  - `declaredSizeBytes(media: unknown): number | undefined` — document size pre-download (photos return undefined)
  - `TgRef { chatId: string; msgId: number; peer: 'user' | 'chat' | 'channel'; accessHash?: string }`
  - `buildRef(ref: TgRef): string` (JSON) / `parseRef(s: unknown): TgRef | null`
  - `inputPeerFor(ref: TgRef): unknown` — real GramJS `Api.InputPeerUser|Chat|Channel` for `getMessages` in `fetchBytes`
  - `peerOfEntity(entity: unknown): { peer: 'user' | 'chat' | 'channel'; accessHash?: string } | null`
  - `attachmentFilename(d: MediaDescriptor): string` — real filename or synthetic (`photo.jpg`, `voice-note.ogg`, `video.mp4`, `sticker.webp`, `file`)
  - `extOf(filename: string): string | undefined`

- [ ] **Step 1: Write the failing test**

`src/__tests__/media.test.ts`:

```ts
import {
  attachmentFilename,
  buildRef,
  declaredSizeBytes,
  describeMedia,
  extOf,
  FILE_DOC_TYPE,
  inputPeerFor,
  MEDIA_SIZE_CAP_BYTES,
  parseRef,
  peerOfEntity,
} from '../media';

describe('describeMedia', () => {
  it('maps photos to image', () => {
    expect(describeMedia({ className: 'MessageMediaPhoto', photo: {} })).toEqual(
      { kind: 'image' },
    );
  });

  it('maps voice documents to audio with duration', () => {
    const media = {
      className: 'MessageMediaDocument',
      document: {
        mimeType: 'audio/ogg',
        attributes: [
          { className: 'DocumentAttributeAudio', voice: true, duration: 65 },
        ],
      },
    };
    expect(describeMedia(media)).toEqual({
      kind: 'audio',
      mimeType: 'audio/ogg',
      durationSec: 65,
    });
  });

  it('maps named documents with filename', () => {
    const media = {
      className: 'MessageMediaDocument',
      document: {
        mimeType: 'application/pdf',
        attributes: [
          { className: 'DocumentAttributeFilename', fileName: 'invoice.pdf' },
        ],
      },
    };
    expect(describeMedia(media)).toEqual({
      kind: 'document',
      mimeType: 'application/pdf',
      filename: 'invoice.pdf',
    });
  });

  it('maps stickers, videos, image-mime documents', () => {
    const sticker = {
      className: 'MessageMediaDocument',
      document: {
        mimeType: 'image/webp',
        attributes: [{ className: 'DocumentAttributeSticker' }],
      },
    };
    expect(describeMedia(sticker)?.kind).toBe('sticker');
    const video = {
      className: 'MessageMediaDocument',
      document: {
        mimeType: 'video/mp4',
        attributes: [{ className: 'DocumentAttributeVideo', duration: 9 }],
      },
    };
    expect(describeMedia(video)).toEqual({
      kind: 'video',
      mimeType: 'video/mp4',
      durationSec: 9,
    });
    const gifLike = {
      className: 'MessageMediaDocument',
      document: { mimeType: 'image/png', attributes: [] },
    };
    expect(describeMedia(gifLike)?.kind).toBe('image');
  });

  it('returns undefined for webpages, polls, and unknowns', () => {
    expect(describeMedia({ className: 'MessageMediaWebPage' })).toBeUndefined();
    expect(describeMedia({ className: 'MessageMediaPoll' })).toBeUndefined();
    expect(describeMedia(undefined)).toBeUndefined();
  });
});

describe('sizes and names', () => {
  it('reads declared document size incl. BigInteger-like values', () => {
    const doc = (size: unknown) => ({
      className: 'MessageMediaDocument',
      document: { size, attributes: [] },
    });
    expect(declaredSizeBytes(doc(1234))).toBe(1234);
    expect(declaredSizeBytes(doc({ toJSNumber: () => 99 }))).toBe(99);
    expect(
      declaredSizeBytes({ className: 'MessageMediaPhoto', photo: {} }),
    ).toBeUndefined();
  });

  it('synthesizes filenames per kind', () => {
    expect(attachmentFilename({ kind: 'document', filename: 'a.pdf' })).toBe(
      'a.pdf',
    );
    expect(attachmentFilename({ kind: 'image' })).toBe('photo.jpg');
    expect(attachmentFilename({ kind: 'audio' })).toBe('voice-note.ogg');
    expect(attachmentFilename({ kind: 'video' })).toBe('video.mp4');
    expect(attachmentFilename({ kind: 'sticker' })).toBe('sticker.webp');
  });

  it('extracts extensions', () => {
    expect(extOf('a.PDF')).toBe('pdf');
    expect(extOf('noext')).toBeUndefined();
  });

  it('exports constants', () => {
    expect(FILE_DOC_TYPE).toBe('telegram.file');
    expect(MEDIA_SIZE_CAP_BYTES).toBe(25 * 1024 * 1024);
  });
});

describe('refs', () => {
  it('round-trips a ref', () => {
    const ref = { chatId: '-100123', msgId: 7, peer: 'channel' as const, accessHash: '99' };
    expect(parseRef(buildRef(ref))).toEqual(ref);
  });

  it('rejects garbage', () => {
    expect(parseRef('not json')).toBeNull();
    expect(parseRef(JSON.stringify({ chatId: 'x' }))).toBeNull();
    expect(parseRef(42)).toBeNull();
  });

  it('builds real GramJS input peers', () => {
    expect(
      (inputPeerFor({ chatId: '42', msgId: 1, peer: 'user', accessHash: '7' }) as { className: string })
        .className,
    ).toBe('InputPeerUser');
    expect(
      (inputPeerFor({ chatId: '-9', msgId: 1, peer: 'chat' }) as { className: string }).className,
    ).toBe('InputPeerChat');
    expect(
      (inputPeerFor({ chatId: '-100123', msgId: 1, peer: 'channel', accessHash: '8' }) as { className: string })
        .className,
    ).toBe('InputPeerChannel');
  });

  it('classifies entities for refs', () => {
    expect(peerOfEntity({ className: 'User', accessHash: { toString: () => '5' } }))
      .toEqual({ peer: 'user', accessHash: '5' });
    expect(peerOfEntity({ className: 'Chat' })).toEqual({ peer: 'chat' });
    expect(peerOfEntity({ className: 'Channel', accessHash: { toString: () => '6' } }))
      .toEqual({ peer: 'channel', accessHash: '6' });
    expect(peerOfEntity(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/media.test.ts -v`
Expected: FAIL — cannot find module `../media`.

- [ ] **Step 3: Write the implementation**

`src/media.ts`:

```ts
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
  if (m.className === 'MessageMediaPhoto' && m.photo) return { kind: 'image' };
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
```

Note: `big-integer` is a transitive dependency of `telegram` — import it directly (it resolves from `telegram`'s own dependency tree in npm's flat layout). If `npx tsc --noEmit` cannot find its types, add `"big-integer": "^1.6.52"` to `dependencies` (it ships its own `.d.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/media.test.ts -v` and `npx tsc --noEmit`
Expected: PASS (11 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/media.ts src/__tests__/media.test.ts package.json package-lock.json
git commit -m "feat: media descriptors, size caps, and self-contained re-fetch refs"
```

---

### Task 5: `messages.ts` (normalization) + `dialogs.ts` (filtering)

**Files:**
- Create: `src/messages.ts`, `src/dialogs.ts`
- Test: `src/__tests__/messages.test.ts`, `src/__tests__/dialogs.test.ts`

**Interfaces:**
- Consumes: `NormalizedMessage`, `ChatInfo` from `./types`; `describeMedia` from `./media`.
- Produces:
  - `RawMessageLike` — duck-type of GramJS `Api.Message`: `{ id: number; date?: number; message?: string; out?: boolean; action?: unknown; media?: unknown; fwdFrom?: { fromName?: string }; replyTo?: { replyToMsgId?: number }; sender?: { firstName?: string; lastName?: string; username?: string; phone?: string; bot?: boolean } | null }`
  - `normalizeMessage(msg: RawMessageLike, opts: { selfName: string; lookup?: (msgId: number) => NormalizedMessage | undefined }): NormalizedMessage | null`
  - `senderName(msg: RawMessageLike, selfName: string): string`
  - `RawDialogLike { isUser: boolean; isGroup: boolean; isChannel: boolean; id?: unknown; name?: string; title?: string; date?: number; entity?: unknown }`
  - `IncludedChat { chatId: string; name: string; type: 'dm' | 'group'; entity: unknown; lastMessageTsMs: number }`
  - `classifyDialog(d: RawDialogLike, selfId: string): IncludedChat | null`
  - `SERVICE_USER_ID = '777000'`, `QUOTE_SNIPPET_MAX = 80`

- [ ] **Step 1: Write the failing tests**

`src/__tests__/messages.test.ts`:

```ts
import { normalizeMessage } from '../messages';
import type { NormalizedMessage } from '../types';

const base = { id: 10, date: 1750000000, message: 'hello' };

describe('normalizeMessage', () => {
  it('normalizes a plain incoming message', () => {
    const m = normalizeMessage(
      { ...base, sender: { firstName: 'Ada', lastName: 'L' } },
      { selfName: 'Me' },
    );
    expect(m).toEqual({
      id: '10',
      tsMs: 1750000000 * 1000,
      sender: 'Ada L',
      text: 'hello',
      system: false,
    });
  });

  it('uses selfName for outgoing, falls back through username/phone', () => {
    expect(
      normalizeMessage({ ...base, out: true }, { selfName: 'Eldar' })?.sender,
    ).toBe('Eldar');
    expect(
      normalizeMessage({ ...base, sender: { username: 'ada' } }, { selfName: 'Me' })
        ?.sender,
    ).toBe('ada');
    expect(
      normalizeMessage({ ...base, sender: { phone: '491701' } }, { selfName: 'Me' })
        ?.sender,
    ).toBe('+491701');
    expect(normalizeMessage({ ...base, sender: null }, { selfName: 'Me' })?.sender)
      .toBe('Unknown');
  });

  it('marks service messages as system with an action label', () => {
    const m = normalizeMessage(
      { id: 3, date: 1750000000, action: { className: 'MessageActionChatAddUser' } },
      { selfName: 'Me' },
    );
    expect(m).toMatchObject({ system: true, sender: null });
    expect(m?.text.length).toBeGreaterThan(0);
  });

  it('prefixes forwards and resolves quotes via lookup', () => {
    const target: NormalizedMessage = {
      id: '5', tsMs: 1, sender: 'Bob', text: 'x'.repeat(200), system: false,
    };
    const m = normalizeMessage(
      {
        ...base,
        fwdFrom: { fromName: 'Carol' },
        replyTo: { replyToMsgId: 5 },
        sender: { firstName: 'Ada' },
      },
      { selfName: 'Me', lookup: (id) => (id === 5 ? target : undefined) },
    );
    expect(m?.text).toBe('fwd from Carol: hello');
    expect(m?.quote).toEqual({ sender: 'Bob', snippet: 'x'.repeat(80) });
  });

  it('keeps media messages with captions and drops truly empty ones', () => {
    const withMedia = normalizeMessage(
      {
        id: 7,
        date: 1750000000,
        message: '',
        media: { className: 'MessageMediaPhoto', photo: {} },
      },
      { selfName: 'Me' },
    );
    expect(withMedia?.media).toEqual({ kind: 'image' });
    expect(
      normalizeMessage({ id: 8, date: 1750000000, message: '' }, { selfName: 'Me' }),
    ).toBeNull();
    expect(
      normalizeMessage(
        { id: 9, date: 1750000000, message: '', media: { className: 'MessageMediaWebPage' } },
        { selfName: 'Me' },
      ),
    ).toBeNull();
  });
});
```

`src/__tests__/dialogs.test.ts`:

```ts
import { classifyDialog } from '../dialogs';

const dlg = (over: Record<string, unknown>) => ({
  isUser: false,
  isGroup: false,
  isChannel: false,
  id: { toString: () => '42' },
  name: 'Chat',
  date: 1750000000,
  entity: {},
  ...over,
});

describe('classifyDialog', () => {
  it('includes user DMs as dm', () => {
    const c = classifyDialog(
      dlg({ isUser: true, entity: { className: 'User' } }),
      '1',
    );
    expect(c).toMatchObject({ chatId: '42', type: 'dm', name: 'Chat' });
    expect(c?.lastMessageTsMs).toBe(1750000000 * 1000);
  });

  it('includes Saved Messages (self) as dm', () => {
    const c = classifyDialog(
      dlg({ isUser: true, id: { toString: () => '1' }, entity: { className: 'User' } }),
      '1',
    );
    expect(c).toMatchObject({ type: 'dm', name: 'Saved Messages' });
  });

  it('excludes bots and the service notification user', () => {
    expect(
      classifyDialog(dlg({ isUser: true, entity: { className: 'User', bot: true } }), '1'),
    ).toBeNull();
    expect(
      classifyDialog(
        dlg({ isUser: true, id: { toString: () => '777000' }, entity: { className: 'User' } }),
        '1',
      ),
    ).toBeNull();
  });

  it('includes basic groups and megagroups as group', () => {
    expect(
      classifyDialog(dlg({ isGroup: true, entity: { className: 'Chat' } }), '1')?.type,
    ).toBe('group');
    // megagroups report BOTH isGroup and isChannel — isGroup wins
    expect(
      classifyDialog(
        dlg({ isGroup: true, isChannel: true, entity: { className: 'Channel', megagroup: true } }),
        '1',
      )?.type,
    ).toBe('group');
  });

  it('excludes broadcast channels', () => {
    expect(
      classifyDialog(
        dlg({ isChannel: true, entity: { className: 'Channel', broadcast: true } }),
        '1',
      ),
    ).toBeNull();
  });

  it('falls back to title then id for the name and skips id-less dialogs', () => {
    expect(
      classifyDialog(
        dlg({ isUser: true, name: undefined, title: 'T', entity: { className: 'User' } }),
        '1',
      )?.name,
    ).toBe('T');
    expect(
      classifyDialog(
        dlg({ isUser: true, name: undefined, title: undefined, entity: { className: 'User' } }),
        '1',
      )?.name,
    ).toBe('42');
    expect(classifyDialog(dlg({ isUser: true, id: undefined }), '1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/messages.test.ts src/__tests__/dialogs.test.ts -v`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

`src/messages.ts`:

```ts
/**
 * Api.Message → NormalizedMessage. Pure and duck-typed: the runtime hands in
 * plain shapes (production: GramJS custom Message objects, whose getters
 * satisfy the same ducks; tests: fixtures). Quote resolution goes through the
 * caller's lookup — no per-message API calls, ever.
 */
import { describeMedia } from './media';
import type { NormalizedMessage } from './types';

export const QUOTE_SNIPPET_MAX = 80;

export interface RawSenderLike {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  phone?: string | null;
  bot?: boolean;
}

export interface RawMessageLike {
  id: number;
  /** Epoch SECONDS (Telegram wire format). */
  date?: number;
  message?: string;
  out?: boolean;
  /** Present ⇒ service message (join/pin/call/…). */
  action?: unknown;
  media?: unknown;
  fwdFrom?: { fromName?: string };
  replyTo?: { replyToMsgId?: number };
  sender?: RawSenderLike | null;
}

/** Human label for the common service actions; generic fallback otherwise. */
function actionLabel(action: unknown): string {
  const cls = (action as { className?: string })?.className ?? '';
  const map: Record<string, string> = {
    MessageActionChatAddUser: 'added a member',
    MessageActionChatDeleteUser: 'removed a member',
    MessageActionChatJoinedByLink: 'joined via invite link',
    MessageActionChatCreate: 'created the group',
    MessageActionChatEditTitle: 'renamed the group',
    MessageActionChatEditPhoto: 'changed the group photo',
    MessageActionPinMessage: 'pinned a message',
    MessageActionPhoneCall: 'call',
    MessageActionHistoryClear: 'cleared history',
  };
  return map[cls] ?? 'service message';
}

export function senderName(msg: RawMessageLike, selfName: string): string {
  if (msg.out) return selfName;
  const s = msg.sender;
  if (s) {
    const full = [s.firstName, s.lastName].filter(Boolean).join(' ');
    if (full) return full;
    if (s.username) return s.username;
    if (s.phone) return `+${s.phone}`;
  }
  return 'Unknown';
}

export function normalizeMessage(
  msg: RawMessageLike,
  opts: {
    selfName: string;
    lookup?: (msgId: number) => NormalizedMessage | undefined;
  },
): NormalizedMessage | null {
  if (typeof msg.id !== 'number') return null;
  const tsMs = (msg.date ?? 0) * 1000;
  if (msg.action) {
    return {
      id: String(msg.id),
      tsMs,
      sender: null,
      text: actionLabel(msg.action),
      system: true,
    };
  }
  const media = describeMedia(msg.media);
  let text = msg.message ?? '';
  if (msg.fwdFrom?.fromName) text = `fwd from ${msg.fwdFrom.fromName}: ${text}`;
  if (!text && !media) return null; // nothing indexable (poll/webpage/geo shells)
  const out: NormalizedMessage = {
    id: String(msg.id),
    tsMs,
    sender: senderName(msg, opts.selfName),
    text,
    system: false,
  };
  if (media) out.media = media;
  const replyId = msg.replyTo?.replyToMsgId;
  if (replyId !== undefined && opts.lookup) {
    const target = opts.lookup(replyId);
    if (target) {
      out.quote = {
        sender: target.sender,
        snippet: target.text.slice(0, QUOTE_SNIPPET_MAX),
      };
    }
  }
  return out;
}
```

`src/dialogs.ts`:

```ts
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
```

Also add `IncludedChat` to `src/types.ts` (append at the end):

```ts
/** A dialog that passed filtering, with what the walker needs to fetch it. */
export interface IncludedChat {
  chatId: string;
  name: string;
  type: 'dm' | 'group';
  /** GramJS entity (User/Chat/Channel) — passed to iterMessages verbatim. */
  entity: unknown;
  /** Epoch ms of the dialog's last message (recent-first ordering). */
  lastMessageTsMs: number;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/__tests__/messages.test.ts src/__tests__/dialogs.test.ts -v`
Expected: PASS (5 + 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/messages.ts src/dialogs.ts src/types.ts src/__tests__/messages.test.ts src/__tests__/dialogs.test.ts
git commit -m "feat: message normalization and dialog filtering"
```

---

### Task 6: `auth.ts` (session blob) + `client.ts` (GramJS seam)

**Files:**
- Create: `src/auth.ts`, `src/client.ts`
- Test: `src/__tests__/auth.test.ts`, `src/__tests__/client.test.ts`

**Interfaces:**
- Consumes: nothing project-internal.
- Produces:
  - `AuthBlob { apiId: number; apiHash: string; session: string }`
  - `saveAuthBlob(file: string, blob: AuthBlob): void` (mkdir -p + write JSON)
  - `loadAuthBlob(file: string, warn?: (msg: string) => void): AuthBlob | null` (null on missing/malformed)
  - `TgClient` — the NARROW client interface every other file depends on (never import GramJS types elsewhere); `QrToken`, `QrSignInParams`
  - `makeTelegramClient(auth: AuthBlob): TgClient` — the production factory; tests inject fakes instead
  - `FLOOD_SLEEP_THRESHOLD_S = 300`

- [ ] **Step 1: Write the failing tests**

`src/__tests__/auth.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadAuthBlob, saveAuthBlob } from '../auth';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tka-')), 'a', 'blob.json');

describe('auth blob', () => {
  it('round-trips through save/load, creating parent dirs', () => {
    const file = tmp();
    const blob = { apiId: 12345, apiHash: 'abcd', session: '1Aa==' };
    saveAuthBlob(file, blob);
    expect(loadAuthBlob(file)).toEqual(blob);
  });

  it('returns null quietly for a missing file', () => {
    const warn = jest.fn();
    expect(loadAuthBlob(tmp(), warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null and warns for malformed content', () => {
    const file = tmp();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"apiId":"nope"}');
    const warn = jest.fn();
    expect(loadAuthBlob(file, warn)).toBeNull();
    expect(warn).toHaveBeenCalled();
    fs.writeFileSync(file, 'not json');
    expect(loadAuthBlob(file, warn)).toBeNull();
  });
});
```

`src/__tests__/client.test.ts` (smoke: real GramJS constructs without network I/O — this also proves GramJS loads under ts-jest):

```ts
import { FLOOD_SLEEP_THRESHOLD_S, makeTelegramClient } from '../client';

describe('makeTelegramClient', () => {
  it('builds a client exposing the TgClient surface', () => {
    const c = makeTelegramClient({ apiId: 1, apiHash: 'a', session: '' });
    for (const fn of [
      'connect', 'disconnect', 'getMe', 'signInUserWithQrCode',
      'iterDialogs', 'iterMessages', 'downloadMedia', 'getMessages',
      'addEventHandler',
    ] as const) {
      expect(typeof (c as Record<string, unknown>)[fn]).toBe('function');
    }
    expect(typeof c.session.save).toBe('function');
    expect(FLOOD_SLEEP_THRESHOLD_S).toBe(300);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/auth.test.ts src/__tests__/client.test.ts -v`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

`src/auth.ts`:

```ts
/**
 * The persisted pairing blob: user-provided api credentials + the GramJS
 * StringSession. Stored PLAINTEXT under the extension's dataDir (same
 * trade-off as the WhatsApp connector — documented in the README): anyone
 * with the file can read the account until the session is revoked from
 * Telegram's Settings → Devices.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface AuthBlob {
  apiId: number;
  apiHash: string;
  session: string;
}

export function saveAuthBlob(file: string, blob: AuthBlob): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(blob));
}

/** null on missing or malformed — caller treats both as "not paired". */
export function loadAuthBlob(
  file: string,
  warn?: (msg: string) => void,
): AuthBlob | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // missing file is the normal never-paired case
  }
  try {
    const v = JSON.parse(raw) as Partial<AuthBlob>;
    if (
      typeof v.apiId !== 'number' ||
      typeof v.apiHash !== 'string' ||
      typeof v.session !== 'string'
    ) {
      throw new Error('missing fields');
    }
    return { apiId: v.apiId, apiHash: v.apiHash, session: v.session };
  } catch {
    warn?.(`telegram: auth blob ${path.basename(file)} is malformed — re-pair the account`);
    return null;
  }
}
```

`src/client.ts`:

```ts
/**
 * The ONLY file that imports GramJS client machinery. Everything else talks
 * to TgClient — a narrow duck of the handful of methods this connector uses —
 * so tests run on plain fakes and a GramJS upgrade has one blast radius.
 */
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';

import type { AuthBlob } from './auth';

/** FLOOD_WAITs up to this many seconds are slept through by GramJS itself. */
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/__tests__/auth.test.ts src/__tests__/client.test.ts -v` and `npx tsc --noEmit`
Expected: PASS (3 + 1 tests); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/client.ts src/__tests__/auth.test.ts src/__tests__/client.test.ts
git commit -m "feat: auth blob persistence and narrow GramJS client seam"
```

---

### Task 7: `walker.ts` (resumable backfill / catch-up)

**Files:**
- Create: `src/walker.ts`
- Test: `src/__tests__/walker.test.ts`

**Interfaces:**
- Consumes: `TgClient` (only `iterMessages`) from `./client`; `IncludedChat`, `TelegramCursor` from `./types`; `RawMessageLike` from `./messages`.
- Produces (used by `runtime.ts`):
  - `WalkerDeps { client: Pick<TgClient, 'iterMessages'>; chats: IncludedChat[]; cursor: TelegramCursor; signal: AbortSignal; emitMessage(chat: IncludedChat, msg: RawMessageLike): Promise<void>; commitPoint(): Promise<void>; log(level: 'debug'|'info'|'warn'|'error', msg: string): void; catchUpOverlapMs?: number; commitEvery?: number; sleep?: (ms: number) => Promise<void> }`
  - `walkChats(deps: WalkerDeps): Promise<void>` — MUTATES `deps.cursor.chats` as it goes; `commitPoint()` is called whenever cursor state is safe to persist
  - `floodSeconds(err: unknown): number | null`
  - Defaults: `CATCH_UP_OVERLAP_MS = 6 * 60 * 60 * 1000`, `COMMIT_EVERY = 500`

**Semantics (from the spec):** chats are walked sequentially in the given order. A chat with `complete: false` continues its descent from `oldestId` (exclusive) all the way to message #1, updating `oldestId`/`newestTsMs` per message. A chat with `complete: true` walks from the top and STOPS at the first message older than `newestTsMs - overlap` (offline-gap catch-up; day-merge dedup makes overlap harmless). FLOOD_WAIT errors longer than GramJS's auto-sleep threshold surface as thrown errors carrying `.seconds` — the walker sleeps and re-enters the same chat, resuming from the mutated cursor.

- [ ] **Step 1: Write the failing test**

`src/__tests__/walker.test.ts`:

```ts
import type { RawMessageLike } from '../messages';
import type { IncludedChat, TelegramCursor } from '../types';
import { floodSeconds, walkChats, type WalkerDeps } from '../walker';

/** msgs must be sorted newest-first (descending id), like Telegram returns. */
function fakeIter(msgs: RawMessageLike[]) {
  return (_entity: unknown, params: { offsetId?: number }) => {
    const below = params.offsetId
      ? msgs.filter((m) => m.id < params.offsetId!)
      : msgs;
    return (async function* () {
      for (const m of below) yield m;
    })();
  };
}

const chat = (chatId: string): IncludedChat => ({
  chatId, name: chatId, type: 'dm', entity: { chatId }, lastMessageTsMs: 0,
});
const msg = (id: number, dateSec: number): RawMessageLike => ({
  id, date: dateSec, message: `m${id}`,
});

function makeDeps(over: Partial<WalkerDeps>): {
  deps: WalkerDeps;
  emitted: Array<{ chatId: string; id: number }>;
  commits: number[];
} {
  const emitted: Array<{ chatId: string; id: number }> = [];
  const commits: number[] = [];
  const deps: WalkerDeps = {
    client: { iterMessages: fakeIter([]) },
    chats: [chat('c1')],
    cursor: { chats: {} },
    signal: new AbortController().signal,
    emitMessage: async (c, m) => {
      emitted.push({ chatId: c.chatId, id: m.id });
    },
    commitPoint: async () => {
      commits.push(emitted.length);
    },
    log: () => {},
    sleep: async () => {},
    ...over,
  };
  return { deps, emitted, commits };
}

describe('walkChats', () => {
  it('walks a fresh chat to the bottom and marks it complete', async () => {
    const { deps, emitted } = makeDeps({
      client: { iterMessages: fakeIter([msg(3, 300), msg(2, 200), msg(1, 100)]) },
    });
    await walkChats(deps);
    expect(emitted.map((e) => e.id)).toEqual([3, 2, 1]);
    expect(deps.cursor.chats.c1).toEqual({
      oldestId: 1, complete: true, newestTsMs: 300_000,
    });
  });

  it('resumes an interrupted backfill below oldestId only', async () => {
    const { deps, emitted } = makeDeps({
      client: { iterMessages: fakeIter([msg(3, 300), msg(2, 200), msg(1, 100)]) },
      cursor: { chats: { c1: { oldestId: 2, complete: false, newestTsMs: 300_000 } } },
    });
    await walkChats(deps);
    expect(emitted.map((e) => e.id)).toEqual([1]);
    expect(deps.cursor.chats.c1.complete).toBe(true);
  });

  it('catch-up on a complete chat stops at the watermark minus overlap', async () => {
    const { deps, emitted } = makeDeps({
      client: {
        iterMessages: fakeIter([msg(9, 900), msg(8, 800), msg(7, 700), msg(6, 600)]),
      },
      cursor: { chats: { c1: { oldestId: 1, complete: true, newestTsMs: 800_000 } } },
      catchUpOverlapMs: 100_000,
    });
    await walkChats(deps);
    // stopAt = 800000 - 100000 = 700000; msg7 (700000) is NOT > stopAt → stop there
    expect(emitted.map((e) => e.id)).toEqual([9, 8]);
    expect(deps.cursor.chats.c1.newestTsMs).toBe(900_000);
  });

  it('commits every commitEvery messages and at chat end', async () => {
    const msgs = Array.from({ length: 5 }, (_, i) => msg(5 - i, (5 - i) * 100));
    const { deps, commits } = makeDeps({
      client: { iterMessages: fakeIter(msgs) },
      commitEvery: 2,
    });
    await walkChats(deps);
    expect(commits).toEqual([2, 4, 5]);
  });

  it('sleeps through a long FLOOD_WAIT and resumes the same chat', async () => {
    let calls = 0;
    const slept: number[] = [];
    const iter = (_e: unknown, params: { offsetId?: number }) => {
      calls += 1;
      return (async function* () {
        if (calls === 1) {
          yield msg(3, 300);
          const err = new Error('FLOOD_WAIT') as Error & { seconds: number };
          err.seconds = 400;
          throw err;
        }
        for (const m of [msg(2, 200), msg(1, 100)]) {
          if (!params.offsetId || m.id < params.offsetId) yield m;
        }
      })();
    };
    const { deps, emitted } = makeDeps({
      client: { iterMessages: iter },
      sleep: async (ms) => { slept.push(ms); },
    });
    await walkChats(deps);
    expect(emitted.map((e) => e.id)).toEqual([3, 2, 1]);
    expect(slept).toEqual([401_000]);
    expect(deps.cursor.chats.c1.complete).toBe(true);
  });

  it('rethrows non-flood errors', async () => {
    const iter = () =>
      (async function* () {
        yield msg(2, 200);
        throw new Error('AUTH_KEY_UNREGISTERED');
      })();
    const { deps } = makeDeps({ client: { iterMessages: iter } });
    await expect(walkChats(deps)).rejects.toThrow('AUTH_KEY_UNREGISTERED');
  });

  it('stops promptly when aborted', async () => {
    const ctrl = new AbortController();
    const emitted: Array<{ chatId: string; id: number }> = [];
    const { deps } = makeDeps({
      client: { iterMessages: fakeIter([msg(3, 300), msg(2, 200), msg(1, 100)]) },
      signal: ctrl.signal,
      emitMessage: async (_c, m) => {
        emitted.push({ chatId: 'c1', id: m.id });
        if (m.id === 3) ctrl.abort();
      },
    });
    await walkChats(deps);
    expect(emitted.map((e) => e.id)).toEqual([3]);
    expect(deps.cursor.chats.c1.complete).toBe(false);
  });

  it('walks chats in the given order', async () => {
    const { deps, emitted } = makeDeps({
      chats: [chat('a'), chat('b')],
      client: {
        iterMessages: (entity: unknown) => {
          const id = (entity as { chatId: string }).chatId === 'a' ? 1 : 2;
          return (async function* () { yield msg(id, id * 100); })();
        },
      },
    });
    await walkChats(deps);
    expect(emitted.map((e) => e.chatId)).toEqual(['a', 'b']);
  });
});

describe('floodSeconds', () => {
  it('extracts seconds from flood-shaped errors only', () => {
    const err = new Error('420: FLOOD_WAIT (caused by messages.GetHistory)') as Error & { seconds: number };
    err.seconds = 33;
    expect(floodSeconds(err)).toBe(33);
    expect(floodSeconds(new Error('nope'))).toBeNull();
    expect(floodSeconds({ seconds: 5 })).toBeNull(); // no FLOOD marker
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/walker.test.ts -v`
Expected: FAIL — cannot find module `../walker`.

- [ ] **Step 3: Write the implementation**

`src/walker.ts`:

```ts
/**
 * The resumable history walker — one mechanism for first-run full-history
 * backfill AND between-run catch-up. Chats are walked sequentially, newest
 * message first within each chat. All progress lives in cursor.chats (mutated
 * in place); commitPoint() marks the moments that state is safe to persist —
 * the runtime flushes buckets and yields a batch carrying the cursor there.
 *
 * FLOOD_WAIT above GramJS's auto-sleep threshold arrives here as a thrown
 * error with `.seconds`. That is EXPECTED under a full-history walk: sleep it
 * out and re-enter the same chat — the mutated cursor makes re-entry cheap.
 */
import type { TgClient } from './client';
import type { RawMessageLike } from './messages';
import type { IncludedChat, TelegramCursor } from './types';

export const CATCH_UP_OVERLAP_MS = 6 * 60 * 60 * 1000;
export const COMMIT_EVERY = 500;

/** Pause between GetHistory pages (seconds) — keeps the walk polite. */
const PAGE_WAIT_S = 1;

export interface WalkerDeps {
  client: Pick<TgClient, 'iterMessages'>;
  chats: IncludedChat[];
  cursor: TelegramCursor;
  signal: AbortSignal;
  emitMessage(chat: IncludedChat, msg: RawMessageLike): Promise<void>;
  commitPoint(): Promise<void>;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void;
  catchUpOverlapMs?: number;
  commitEvery?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Seconds to wait when err is a Telegram flood error; null otherwise. */
export function floodSeconds(err: unknown): number | null {
  const e = err as { seconds?: unknown; errorMessage?: unknown; message?: unknown };
  if (typeof e?.seconds !== 'number') return null;
  const text = `${String(e.errorMessage ?? '')} ${String(e.message ?? '')}`;
  return text.includes('FLOOD') ? e.seconds : null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

export async function walkChats(deps: WalkerDeps): Promise<void> {
  const overlap = deps.catchUpOverlapMs ?? CATCH_UP_OVERLAP_MS;
  const commitEvery = deps.commitEvery ?? COMMIT_EVERY;
  const sleep = deps.sleep ?? defaultSleep;

  for (const chat of deps.chats) {
    if (deps.signal.aborted) return;
    const progress = (deps.cursor.chats[chat.chatId] ??= {
      complete: false,
      newestTsMs: 0,
    });

    // Retry loop: a long FLOOD_WAIT breaks the iterator; re-enter the same
    // chat from the (mutated) cursor until it finishes or aborts.
    let done = false;
    while (!done && !deps.signal.aborted) {
      const wasComplete = progress.complete;
      const stopAt = wasComplete ? progress.newestTsMs - overlap : -Infinity;
      let sinceCommit = 0;
      let emittedAny = false;
      try {
        const iter = deps.client.iterMessages(chat.entity, {
          // Catch-up walks from the top; backfill continues below oldestId.
          offsetId: wasComplete ? 0 : progress.oldestId ?? 0,
          waitTime: PAGE_WAIT_S,
        });
        for await (const raw of iter) {
          if (deps.signal.aborted) return;
          const m = raw as RawMessageLike;
          if (typeof m?.id !== 'number') continue;
          const tsMs = (m.date ?? 0) * 1000;
          if (wasComplete && tsMs <= stopAt) break; // caught up
          await deps.emitMessage(chat, m);
          emittedAny = true;
          if (!wasComplete) progress.oldestId = m.id;
          if (tsMs > progress.newestTsMs) progress.newestTsMs = tsMs;
          sinceCommit += 1;
          if (sinceCommit >= commitEvery) {
            sinceCommit = 0;
            await deps.commitPoint();
          }
        }
        if (!wasComplete) progress.complete = true;
        if (emittedAny || !wasComplete) await deps.commitPoint();
        done = true; // clean finish — a thrown flood lands in catch instead
      } catch (err) {
        const seconds = floodSeconds(err);
        if (seconds === null) throw err;
        deps.log(
          'warn',
          `telegram: FLOOD_WAIT ${seconds}s while walking ${chat.name} — sleeping`,
        );
        await deps.commitPoint(); // persist progress before the long nap
        await sleep((seconds + 1) * 1000);
        // loop re-enters this chat
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/walker.test.ts -v`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/walker.ts src/__tests__/walker.test.ts
git commit -m "feat: resumable full-history walker with catch-up watermarks and flood-wait recovery"
```

---

### Task 8: `runtime.ts` (TelegramPullRuntime)

**Files:**
- Create: `src/runtime.ts`
- Test: `src/__tests__/runtime.test.ts`

**Interfaces:**
- Consumes: `AsyncBatchQueue` (queue), `walkChats` (walker), `classifyDialog` (dialogs), `normalizeMessage`/`RawMessageLike` (messages), `dayKey`/`mergeMessages` (chat-day), `describeMedia`/`declaredSizeBytes`/`buildRef`/`peerOfEntity`/`attachmentFilename`/`MEDIA_SIZE_CAP_BYTES`/`MEDIA_BACKFILL_WINDOW_MS` (media), `TgClient` (client), types.
- Produces (used by `source.ts`):
  - `RuntimeDeps { client: TgClient; initialCursor: TelegramCursor | null; events: { newMessage: unknown; editedMessage: unknown }; loadPriorMessages(externalId: string): Promise<NormalizedMessage[] | null>; hasStoredFile(externalId: string): Promise<boolean>; log(level: 'debug'|'info'|'warn'|'error', msg: string): void; nowMs?: () => number; flushDebounceMs?: number; commitEvery?: number; catchUpOverlapMs?: number; mediaWindowMs?: number; sleep?: (ms: number) => Promise<void> }`
  - `class TelegramPullRuntime { constructor(deps); start(): Promise<void>; nextBatch(): Promise<Batch<TelegramCursor, TelegramItem> | null>; stop(): Promise<void>; loggedOut: boolean; fatalError: Error | null }`
  - `isAuthLossError(err: unknown): boolean`
  - `FLUSH_DEBOUNCE_MS = 3000`, `RECENT_INDEX_CAP = 2000`

**Semantics:** `start()` connects, resolves self (`getMe`), attaches both event handlers, filters+sorts dialogs (recent activity first), then kicks the walker as a background promise. Walker emits and live events land in the same (chat, day) buckets; `commitPoint()`/debounce flush merges each bucket against the prior stored ledger (`loadPriorMessages`) and pushes one `Batch` — day items first, then pending file items — with a deep-cloned cursor. Flushes are serialized on a promise chain (walker commit and live debounce must not interleave). Media bytes download one at a time inside ingestion, only within the window (backfill) or always (live), skipping docs already stored (`hasStoredFile`) and anything over cap. Walker failure: flood is handled inside the walker; anything else lands in `fatal()` — auth-loss sets `loggedOut`, everything sets `fatalError` and closes the queue. `stop()` is idempotent: abort walker, await it, final flush, close queue, disconnect.

- [ ] **Step 1: Write the failing test**

`src/__tests__/runtime.test.ts`:

```ts
import { DOC_TYPE } from '../chat-day';
import type { RawMessageLike } from '../messages';
import { isAuthLossError, TelegramPullRuntime, type RuntimeDeps } from '../runtime';
import type { DayItem, FileItem, NormalizedMessage } from '../types';

type Handler = (event: unknown) => void | Promise<void>;

class FakeClient {
  connected = false;
  disconnects = 0;
  handlers: Array<{ cb: Handler; ev: unknown }> = [];
  dialogs: unknown[] = [];
  messagesByChat: Record<string, RawMessageLike[]> = {};
  downloads: unknown[] = [];
  downloadResult: Buffer | undefined = Buffer.from('media-bytes');
  failWalkWith: Error | null = null;

  async connect() { this.connected = true; }
  async disconnect() { this.disconnects += 1; this.connected = false; }
  async getMe() { return { id: 1, firstName: 'Eldar' }; }
  async signInUserWithQrCode() { return {}; }
  addEventHandler(cb: Handler, ev: unknown) { this.handlers.push({ cb, ev }); }
  iterDialogs(_p: { ignoreMigrated?: boolean }) {
    const dialogs = this.dialogs;
    return (async function* () { for (const d of dialogs) yield d; })();
  }
  iterMessages(entity: unknown, params: { offsetId?: number }) {
    const chatId = (entity as { chatId: string }).chatId;
    const msgs = this.messagesByChat[chatId] ?? [];
    const fail = this.failWalkWith;
    return (async function* () {
      for (const m of msgs) {
        if (params.offsetId && m.id >= params.offsetId) continue;
        yield m;
      }
      if (fail) throw fail;
    })();
  }
  async downloadMedia(message: unknown) { this.downloads.push(message); return this.downloadResult; }
  async getMessages() { return []; }
  session = { save: () => 'sess' };
}

const userDialog = (chatId: string, name: string, dateSec = 1750_000_000) => ({
  isUser: true, isGroup: false, isChannel: false,
  id: { toString: () => chatId }, name, date: dateSec,
  entity: { className: 'User', chatId },
});

const NOW = 1750_000_000_000;

function makeRuntime(over: Partial<RuntimeDeps> & { client: FakeClient }) {
  const prior = new Map<string, NormalizedMessage[]>();
  const stored = new Set<string>();
  const deps: RuntimeDeps = {
    initialCursor: null,
    events: { newMessage: { tag: 'new' }, editedMessage: { tag: 'edit' } },
    loadPriorMessages: async (id) => prior.get(id) ?? null,
    hasStoredFile: async (id) => stored.has(id),
    log: () => {},
    nowMs: () => NOW,
    flushDebounceMs: 5,
    sleep: async () => {},
    ...over,
  } as RuntimeDeps;
  return { rt: new TelegramPullRuntime(deps), prior, stored };
}

const msg = (id: number, dateSec: number, text: string, extra: Partial<RawMessageLike> = {}): RawMessageLike =>
  ({ id, date: dateSec, message: text, sender: { firstName: 'Ada' }, ...extra });

describe('TelegramPullRuntime', () => {
  it('backfills dialogs into merged day batches with cursor snapshots', async () => {
    const client = new FakeClient();
    client.dialogs = [
      userDialog('42', 'Ada'),
      { ...userDialog('777000', 'Telegram'), id: { toString: () => '777000' } },
    ];
    client.messagesByChat['42'] = [msg(2, 1750_000_100, 'two'), msg(1, 1750_000_000, 'one')];
    const { rt, prior } = makeRuntime({ client });
    prior.set('42:' + dayOf(1750_000_000_000), [
      { id: '0', tsMs: 1_749_999_000_000, sender: 'Ada', text: 'zero', system: false },
    ]);
    await rt.start();
    const batch = await rt.nextBatch();
    expect(batch?.phase).toBe('backfill');
    const day = batch!.items[0] as DayItem;
    expect(day.kind).toBe('day');
    expect(day.chat).toEqual({ chatId: '42', name: 'Ada', type: 'dm' });
    // prior ledger merged in, ascending order
    expect(day.messages.map((m) => m.id)).toEqual(['0', '1', '2']);
    expect(batch!.cursor.chats['42']).toEqual({
      oldestId: 1, complete: true, newestTsMs: 1750_000_100_000,
    });
    await rt.stop();
    expect(client.disconnects).toBeGreaterThan(0);
  });

  it('flushes live events after the debounce, phase live, with quote lookup', async () => {
    const client = new FakeClient();
    client.dialogs = [userDialog('42', 'Ada')];
    client.messagesByChat['42'] = [msg(1, 1750_000_000, 'hello')];
    const { rt } = makeRuntime({ client });
    await rt.start();
    await rt.nextBatch(); // drain backfill
    const newHandler = client.handlers.find((h) => (h.ev as { tag: string }).tag === 'new')!;
    await newHandler.cb({
      chatId: { toString: () => '42' },
      message: msg(5, 1750_000_500, 'reply!', { replyTo: { replyToMsgId: 1 } }),
    });
    const batch = await rt.nextBatch();
    expect(batch?.phase).toBe('live');
    const day = batch!.items[0] as DayItem;
    const m5 = day.messages.find((m) => m.id === '5')!;
    expect(m5.quote).toEqual({ sender: 'Ada', snippet: 'hello' });
    await rt.stop();
  });

  it('ignores live events for excluded or unknown chats', async () => {
    const client = new FakeClient();
    client.dialogs = [userDialog('42', 'Ada')];
    const { rt } = makeRuntime({ client });
    await rt.start();
    // No messages anywhere ⇒ the walk flushes nothing; give it a tick to end.
    await new Promise((r) => setTimeout(r, 10));
    const newHandler = client.handlers.find((h) => (h.ev as { tag: string }).tag === 'new')!;
    await newHandler.cb({ chatId: { toString: () => '999' }, message: msg(9, 1750_000_900, 'spam') });
    await rt.stop();
    const drained: unknown[] = [];
    for (;;) { const b = await rt.nextBatch(); if (b === null) break; drained.push(b); }
    expect(drained).toEqual([]);
  });

  it('downloads in-window media as file items parented after the day, skipping stored and oversized', async () => {
    const client = new FakeClient();
    client.dialogs = [userDialog('42', 'Ada')];
    const media = { className: 'MessageMediaDocument', document: { size: 10, mimeType: 'application/pdf', attributes: [{ className: 'DocumentAttributeFilename', fileName: 'a.pdf' }] } };
    const bigMedia = { className: 'MessageMediaDocument', document: { size: 26 * 1024 * 1024, mimeType: 'application/pdf', attributes: [] } };
    const oldSec = (NOW - 200 * 24 * 3600 * 1000) / 1000; // outside 180d window
    client.messagesByChat['42'] = [
      msg(4, 1750_000_400, '', { media: bigMedia }),
      msg(3, 1750_000_300, 'stored', { media }),
      msg(2, 1750_000_200, 'fresh', { media }),
      msg(1, Math.floor(oldSec), 'old', { media }),
    ];
    const { rt, stored } = makeRuntime({ client });
    stored.add('42:3');
    await rt.start();
    const batch = await rt.nextBatch();
    const files = batch!.items.filter((i): i is FileItem => (i as FileItem).kind === 'file');
    expect(files.map((f) => f.msgId)).toEqual(['2']); // stored, oversized, out-of-window all skipped
    expect(files[0].filename).toBe('a.pdf');
    expect(Buffer.from(files[0].bytes).toString()).toBe('media-bytes');
    expect(JSON.parse(files[0].ref)).toMatchObject({ chatId: '42', msgId: 2, peer: 'user' });
    // day items come before file items
    expect((batch!.items[0] as DayItem).kind).toBe('day');
    await rt.stop();
  });

  it('marks loggedOut on auth-loss walker errors and closes the queue', async () => {
    const client = new FakeClient();
    client.dialogs = [userDialog('42', 'Ada')];
    client.messagesByChat['42'] = [msg(1, 1750_000_000, 'hi')];
    client.failWalkWith = new Error('AUTH_KEY_UNREGISTERED');
    const { rt } = makeRuntime({ client });
    await rt.start();
    for (;;) { const b = await rt.nextBatch(); if (b === null) break; }
    expect(rt.loggedOut).toBe(true);
    await rt.stop();
  });

  it('stop() ends the stream: drain hits null and the client disconnects', async () => {
    const client = new FakeClient();
    client.dialogs = [userDialog('42', 'Ada')];
    client.messagesByChat['42'] = [msg(1, 1750_000_000, 'hi')];
    const { rt } = makeRuntime({ client });
    await rt.start();
    expect(await rt.nextBatch()).not.toBeNull(); // walker's chat-end flush
    await rt.stop();
    for (;;) { const b = await rt.nextBatch(); if (b === null) break; }
    expect(client.disconnects).toBeGreaterThan(0);
  });
});

describe('isAuthLossError', () => {
  it('recognizes the auth-loss family only', () => {
    expect(isAuthLossError(new Error('AUTH_KEY_UNREGISTERED'))).toBe(true);
    expect(isAuthLossError({ errorMessage: 'SESSION_REVOKED' })).toBe(true);
    expect(isAuthLossError(new Error('FLOOD_WAIT'))).toBe(false);
  });
});

function dayOf(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/runtime.test.ts -v`
Expected: FAIL — cannot find module `../runtime`.

- [ ] **Step 3: Write the implementation**

`src/runtime.ts`:

```ts
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
      log: (l, m) => this.deps.log(l, m),
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
      // ONE download at a time by construction — ingest is awaited serially.
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
    this.flushChain = this.flushChain.then(() => this.doFlush(phase));
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/runtime.test.ts -v` and `npx tsc --noEmit`
Expected: PASS (7 tests); typecheck clean. If the `Batch`/`LogLevel` import names differ in the vendored contract, check `src/kiagent-contracts.ts` — the types exist (WhatsApp's source imports them); adjust the import list, never the contract file.

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts src/__tests__/runtime.test.ts
git commit -m "feat: pull runtime — bucketed day merges, live debounce, media downloads, auth-loss detection"
```

---

### Task 9: `source.ts` (the connector surface)

**Files:**
- Create: `src/source.ts`
- Test: `src/__tests__/source.test.ts`

**Interfaces:**
- Consumes: everything prior — `loadAuthBlob`/`saveAuthBlob`/`AuthBlob`, `DOC_TYPE`/`dayTitle`/`renderDay`, `makeTelegramClient`/`TgClient`, `FILE_DOC_TYPE`/`extOf`/`inputPeerFor`/`parseRef`/`MEDIA_SIZE_CAP_BYTES`, `TelegramPullRuntime`, contract types (`AuthChannel`, `Session`, `Source`, `Document`, `DocumentInput`, `HostFor`).
- Produces (used by `index.ts`):
  - `TelegramHost = HostFor<'net' | 'query'>`
  - `createTelegramSource(host: TelegramHost, seams?: TelegramSourceSeams): Source<TelegramCursor, TelegramItem>`
  - `TelegramSourceSeams { makeClient?: (auth: AuthBlob) => TgClient; events?: { newMessage: unknown; editedMessage: unknown }; pairingTimeoutMs?: number; flushDebounceMs?: number; commitEvery?: number; catchUpOverlapMs?: number; mediaWindowMs?: number; nowMs?: () => number; sleep?: (ms: number) => Promise<void> }`
  - `PAIRING_TIMEOUT_MS = 180_000`

- [ ] **Step 1: Write the failing test**

`src/__tests__/source.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { saveAuthBlob, type AuthBlob } from '../auth';
import { DOC_TYPE } from '../chat-day';
import type { QrSignInParams } from '../client';
import type { AuthChannel, Document, Session } from '../kiagent-contracts';
import { buildRef, FILE_DOC_TYPE } from '../media';
import { createTelegramSource, type TelegramHost } from '../source';
import type { DayItem, FileItem, NormalizedMessage, TelegramItem } from '../types';

const EV = { newMessage: { tag: 'new' }, editedMessage: { tag: 'edit' } };

function makeHost(): { host: TelegramHost; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tks-'));
  const host = {
    self: { id: 'kia.telegram', dataDir },
    log: () => {},
    query: { byExternalId: jest.fn(async () => null) },
  } as unknown as TelegramHost;
  return { host, dataDir };
}

function makeAuthChannel(answers: Array<Record<string, unknown>>) {
  const qrs: string[] = [];
  const prompts: unknown[] = [];
  const channel = {
    oauth: jest.fn(),
    showQr: (qr: string) => { qrs.push(qr); },
    prompt: jest.fn(async (schema: unknown) => {
      prompts.push(schema);
      return answers.shift() ?? {};
    }),
    status: jest.fn(),
  } as unknown as AuthChannel;
  return { channel, qrs, prompts };
}

/** Pairing-only fake: records the sign-in params and drives the callbacks. */
class FakePairClient {
  needPassword = false;
  neverSettle = false;
  receivedPassword: string | null = null;
  disconnects = 0;
  async connect() {}
  async disconnect() { this.disconnects += 1; }
  async getMe() { return { id: { toString: () => '42' }, firstName: 'Eldar' }; }
  async signInUserWithQrCode(_c: unknown, params: QrSignInParams) {
    if (this.neverSettle) return new Promise(() => {});
    await params.qrCode({ token: Buffer.from('tok'), expires: 0 });
    if (this.needPassword) {
      this.receivedPassword = (await params.password?.('myhint')) ?? null;
    }
    return {};
  }
  session = { save: () => 'SESSION_STRING' };
  // unused Source-side surface
  iterDialogs() { return (async function* () {})(); }
  iterMessages() { return (async function* () {})(); }
  async downloadMedia(): Promise<Buffer | undefined> { return undefined; }
  async getMessages(): Promise<unknown[]> { return []; }
  addEventHandler() {}
}

/** Sync-side fake: one dialog, canned messages, optional walk failure. */
class FakeSyncClient extends FakePairClient {
  messages: unknown[] = [];
  failWalkWith: Error | null = null;
  mediaBuffer: Buffer | undefined = undefined;
  gotMessages: unknown[] = [{ id: 2, media: {} }];
  iterDialogs() {
    return (async function* () {
      yield {
        isUser: true, isGroup: false, isChannel: false,
        id: { toString: () => '42' }, name: 'Ada', date: 1750_000_000,
        entity: { className: 'User', accessHash: { toString: () => '7' } },
      };
    })();
  }
  iterMessages() {
    const msgs = this.messages;
    const fail = this.failWalkWith;
    return (async function* () {
      for (const m of msgs) yield m;
      if (fail) throw fail;
    })();
  }
  async downloadMedia() { return this.mediaBuffer; }
  async getMessages() { return this.gotMessages; }
}

function makeSession(over: Partial<{ config: Record<string, unknown> }> = {}): {
  session: Session; ctrl: AbortController; logs: string[];
} {
  const ctrl = new AbortController();
  const logs: string[] = [];
  const session = {
    account: {
      id: 'acc1',
      identifier: '42',
      config: over.config ?? { authFile: 'auth/42.json' },
    },
    signal: ctrl.signal,
    credentials: async () => null,
    log: (_l: string, m: string) => { logs.push(m); },
  } as unknown as Session;
  return { session, ctrl, logs };
}

const blob: AuthBlob = { apiId: 123, apiHash: 'h', session: 'S' };

async function drain(
  gen: AsyncIterable<{ phase: string; items: TelegramItem[] }>,
  onFirst?: () => void,
) {
  const batches: Array<{ phase: string; items: TelegramItem[] }> = [];
  for await (const b of gen) {
    batches.push(b);
    onFirst?.();
  }
  return batches;
}

describe('descriptor', () => {
  it('declares the pairing source', () => {
    const { host } = makeHost();
    const d = createTelegramSource(host, { events: EV }).descriptor;
    expect(d).toMatchObject({
      id: 'telegram',
      auth: 'pairing',
      multiAccount: true,
      documentTypes: [DOC_TYPE, FILE_DOC_TYPE],
    });
  });
});

describe('connect', () => {
  it('prompts for api creds, shows the QR deep link, saves the blob', async () => {
    const { host, dataDir } = makeHost();
    const client = new FakePairClient();
    const src = createTelegramSource(host, { makeClient: () => client, events: EV });
    const { channel, qrs } = makeAuthChannel([{ apiId: 123, apiHash: ' h ' }]);
    const res = await src.connect(channel);
    expect(res).toEqual({ identifier: '42', config: { authFile: 'auth/42.json' } });
    expect(qrs[0]).toBe(`tg://login?token=${Buffer.from('tok').toString('base64url')}`);
    const saved = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'auth/42.json'), 'utf8'),
    );
    expect(saved).toEqual({ apiId: 123, apiHash: 'h', session: 'SESSION_STRING' });
    expect(client.disconnects).toBe(1);
  });

  it('collects the 2FA password through a second prompt', async () => {
    const { host } = makeHost();
    const client = new FakePairClient();
    client.needPassword = true;
    const src = createTelegramSource(host, { makeClient: () => client, events: EV });
    const { channel, prompts } = makeAuthChannel([
      { apiId: 123, apiHash: 'h' },
      { password: 'pw' },
    ]);
    await src.connect(channel);
    expect(client.receivedPassword).toBe('pw');
    expect(JSON.stringify(prompts[1])).toContain('myhint');
  });

  it('rejects missing credentials and times out a stuck pairing', async () => {
    const { host } = makeHost();
    const stuck = new FakePairClient();
    stuck.neverSettle = true;
    const src = createTelegramSource(host, {
      makeClient: () => stuck, events: EV, pairingTimeoutMs: 20,
    });
    const bad = makeAuthChannel([{}]);
    await expect(src.connect(bad.channel)).rejects.toThrow(/api_id and api_hash/);
    const ok = makeAuthChannel([{ apiId: 1, apiHash: 'h' }]);
    await expect(src.connect(ok.channel)).rejects.toThrow(/timed out/);
    expect(stuck.disconnects).toBe(1);
  });
});

describe('pull', () => {
  it('throws not-paired without a config or blob', async () => {
    const { host } = makeHost();
    const src = createTelegramSource(host, { events: EV });
    const { session } = makeSession({ config: {} });
    await expect(drain(src.pull(session, null))).rejects.toThrow(/not paired/);
    const { session: s2 } = makeSession(); // config points at a missing file
    await expect(drain(src.pull(s2, null))).rejects.toThrow(/not paired/);
  });

  it('yields backfill batches and stops cleanly on abort', async () => {
    const { host, dataDir } = makeHost();
    saveAuthBlob(path.join(dataDir, 'auth/42.json'), blob);
    const client = new FakeSyncClient();
    client.messages = [{ id: 1, date: 1750_000_000, message: 'hi', sender: { firstName: 'Ada' } }];
    const src = createTelegramSource(host, {
      makeClient: () => client, events: EV, flushDebounceMs: 5,
    });
    const { session, ctrl } = makeSession();
    const batches = await drain(src.pull(session, null), () => ctrl.abort());
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0].phase).toBe('backfill');
    const day = batches[0].items[0] as DayItem;
    expect(day.messages[0].text).toBe('hi');
    expect(client.disconnects).toBeGreaterThan(0);
  });

  it('throws a 401-shaped error after auth loss', async () => {
    const { host, dataDir } = makeHost();
    saveAuthBlob(path.join(dataDir, 'auth/42.json'), blob);
    const client = new FakeSyncClient();
    client.messages = [{ id: 1, date: 1750_000_000, message: 'hi' }];
    client.failWalkWith = new Error('AUTH_KEY_UNREGISTERED');
    const src = createTelegramSource(host, { makeClient: () => client, events: EV });
    const { session } = makeSession();
    await expect(drain(src.pull(session, null))).rejects.toMatchObject({ status: 401 });
  });
});

describe('toDocument', () => {
  const { host } = makeHost();
  const src = createTelegramSource(host, { events: EV });

  it('renders a day item into a chat-day document', () => {
    const messages: NormalizedMessage[] = [
      { id: '1', tsMs: Date.UTC(2026, 6, 17, 9, 0), sender: 'Ada', text: 'hi', system: false },
    ];
    const doc = src.toDocument({
      kind: 'day',
      chat: { chatId: '42', name: 'Ada', type: 'dm' },
      day: '2026-07-17',
      messages,
    }) as Record<string, unknown>;
    expect(doc).toMatchObject({
      externalId: '42:2026-07-17',
      type: DOC_TYPE,
      title: 'Ada — Jul 17, 2026',
      url: 'telegram://chat?id=42',
      metadata: {
        chat_key: '42',
        chat_key_kind: 'tg_chat_id',
        chat_type: 'dm',
        messages,
      },
    });
    expect(typeof doc.markdown).toBe('string');
  });

  it('renders a file item as a parented binary document', () => {
    const item: FileItem = {
      kind: 'file', chatId: '42', day: '2026-07-17', msgId: '2',
      bytes: new Uint8Array([1, 2]), mediaKind: 'document',
      ref: buildRef({ chatId: '42', msgId: 2, peer: 'user', accessHash: '7' }),
      mimeType: 'application/pdf', filename: 'a.pdf',
      sentAtMs: Date.UTC(2026, 6, 17, 9, 0),
    };
    const doc = src.toDocument(item) as Record<string, unknown>;
    expect(doc).toMatchObject({
      externalId: '42:2',
      type: FILE_DOC_TYPE,
      title: 'a.pdf',
      markdown: null,
      parent: { externalId: '42:2026-07-17', type: DOC_TYPE },
      metadata: {
        chat_key: '42', sizeBytes: 2, mime: 'application/pdf',
        filename: 'a.pdf', ext: 'pdf', tg_msg: item.ref,
      },
    });
  });
});

describe('fetchBytes', () => {
  const ref = buildRef({ chatId: '42', msgId: 2, peer: 'user', accessHash: '7' });
  const docWith = (tg_msg: unknown) =>
    ({ externalId: '42:2', metadata: { tg_msg } }) as unknown as Document;

  it('re-downloads bytes through a short-lived client', async () => {
    const { host, dataDir } = makeHost();
    saveAuthBlob(path.join(dataDir, 'auth/42.json'), blob);
    const client = new FakeSyncClient();
    client.mediaBuffer = Buffer.from('xyz');
    const src = createTelegramSource(host, { makeClient: () => client, events: EV });
    const { session } = makeSession();
    const bytes = await src.fetchBytes!(session, docWith(ref));
    expect(bytes && Buffer.from(bytes).toString()).toBe('xyz');
    expect(client.disconnects).toBe(1);
  });

  it('returns null for unreadable refs, missing messages, oversized media', async () => {
    const { host, dataDir } = makeHost();
    saveAuthBlob(path.join(dataDir, 'auth/42.json'), blob);
    const client = new FakeSyncClient();
    const src = createTelegramSource(host, { makeClient: () => client, events: EV });
    const { session, logs } = makeSession();
    expect(await src.fetchBytes!(session, docWith('garbage'))).toBeNull();
    expect(logs.some((l) => l.includes('unreadable'))).toBe(true);
    client.gotMessages = [];
    expect(await src.fetchBytes!(session, docWith(ref))).toBeNull();
    client.gotMessages = [{ id: 2, media: {} }];
    client.mediaBuffer = Buffer.alloc(26 * 1024 * 1024);
    expect(await src.fetchBytes!(session, docWith(ref))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/source.test.ts -v`
Expected: FAIL — cannot find module `../source`.

- [ ] **Step 3: Write the implementation**

`src/source.ts`:

```ts
/**
 * The Telegram source: QR pairing in connect() (auth blob persisted under the
 * extension's dataDir — see the README privacy note on plaintext storage),
 * and a pull() that owns one long-lived GramJS client per account and never
 * returns while healthy: the resumable history walker streams 'backfill'
 * batches, live events stream 'live' batches, media bytes land as parented
 * `file` items. The engine drains the iterable with no per-batch timeout —
 * the open generator IS the realtime path.
 */
import path from 'node:path';

import { NewMessage } from 'telegram/events';
import { EditedMessage } from 'telegram/events/EditedMessage';

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
  /** Event builder instances (GramJS NewMessage/EditedMessage by default). */
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
        // GramJS swallows the real failure and throws AUTH_USER_CANCEL when
        // onError returns true — capture it so the user sees the cause.
        let pairError: Error | null = null;
        try {
          await withTimeout(
            client.signInUserWithQrCode(
              { apiId, apiHash },
              {
                qrCode: async ({ token }) => {
                  auth.showQr(`tg://login?token=${token.toString('base64url')}`);
                  auth.status(
                    'Scan with Telegram on your phone: Settings → Devices → Link Desktop Device',
                  );
                },
                // GramJS drives the 2FA (SESSION_PASSWORD_NEEDED) flow through
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/source.test.ts -v` and `npx tsc --noEmit`
Expected: PASS (10 tests); typecheck clean. Notes if something fights back:
- If `answers.apiId`/`answers.password` property access errors under strict typing, the contract's `prompt` returns `Record<string, unknown>` — access is legal; check the vendored contract signature.
- `me.id` stringification: `String()` on an object calls its `toString()` — the fake's `{ toString: () => '42' }` yields `'42'`, same as GramJS BigInteger in production.

- [ ] **Step 5: Commit**

```bash
git add src/source.ts src/__tests__/source.test.ts
git commit -m "feat: telegram source — QR connect, live pull, documents, deep-extraction refetch"
```

---

### Task 10: `index.ts` + bundle-load smoke test

**Files:**
- Create: `src/index.ts`
- Test: `src/__tests__/bundle-load.test.ts`

**Interfaces:**
- Consumes: `createTelegramSource` from `./source`, `ExtensionModule` from `./kiagent-contracts`.
- Produces: the module the platform child `require()`s — default export (AND `module.exports`) with `activate(host) → { sources: [source] }`.

- [ ] **Step 1: Write the failing test**

`src/__tests__/bundle-load.test.ts` — builds the real esbuild bundle and loads it exactly the way the extension host does (this is the gate for "GramJS bundles cleanly"):

```ts
import { execSync } from 'node:child_process';
import path from 'node:path';

jest.setTimeout(120_000);

const root = path.resolve(__dirname, '..', '..');

describe('bundle', () => {
  it('esbuild output require()s cleanly and activates one source', async () => {
    execSync('node build.mjs', { cwd: root, stdio: 'pipe' });
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const bundled = require(path.join(root, 'dist', 'index.js')) as {
      default?: { activate: (host: unknown) => Promise<unknown> };
      activate?: (host: unknown) => Promise<unknown>;
    };
    const mod = bundled.default ?? bundled;
    expect(typeof mod.activate).toBe('function');
    const host = { self: { id: 'kia.telegram', dataDir: '/tmp' }, log: () => {} };
    const result = (await mod.activate(host)) as {
      sources: Array<{ descriptor: { id: string; auth: string } }>;
    };
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].descriptor).toMatchObject({
      id: 'telegram',
      auth: 'pairing',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/bundle-load.test.ts -v`
Expected: FAIL — `build.mjs` errors because `src/index.ts` does not exist.

- [ ] **Step 3: Write the implementation**

`src/index.ts`:

```ts
import type { ExtensionModule } from './kiagent-contracts';
import { createTelegramSource } from './source';

const mod = {
  async activate(host) {
    return { sources: [createTelegramSource(host)] };
  },
} satisfies ExtensionModule<'net' | 'query'>;

export default mod;
module.exports = mod; // dual export — the host child require()s CJS
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/bundle-load.test.ts -v`
Expected: PASS. If esbuild fails on a GramJS import, the permitted fallback (spec §Risks) is adding the failing module to `external` in `build.mjs` — but then it MUST be shipped in the tarball; prefer fixing the bundle. Also run `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/__tests__/bundle-load.test.ts
git commit -m "feat: extension entry point with bundle-load smoke test"
```

---

### Task 11: README + full verification

**Files:**
- Create: `README.md`
- Modify: nothing else — this task is docs + running every gate.

**Interfaces:**
- Consumes: everything; the README documents the behavior earlier tasks built.
- Produces: the shipped README (listed in `package.json` `files`).

- [ ] **Step 1: Write `README.md`**

```markdown
# Telegram connector for KIAgent

A Telegram connector for KIAgent (extension platform). It signs in to your
Telegram account as a third-party client through the official MTProto API
(via [GramJS](https://github.com/gram-js/gramjs)) and ingests your DMs and
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

- `net` — the connector talks to Telegram's servers over GramJS's own
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
  `HH:MM Sender: text`, reply quotes inline (`↳re …`), media as labels
  (`[image]`, `[voice note 1:05]`, `[document: report.pdf]`), forwards
  prefixed `fwd from …`, and service notices in italics.
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
```

- [ ] **Step 2: Run every gate**

```bash
npx tsc --noEmit
npx jest
node build.mjs
node scripts/gen-icon.mjs   # regenerate to confirm determinism
git status --short          # only README.md should be new/modified
```

Expected: typecheck clean; ALL suites pass (chat-day, queue, media, messages, dialogs, auth, client, walker, runtime, source, bundle-load); build succeeds; `git status` shows only intended changes (`dist/` and `node_modules/` are ignored).

- [ ] **Step 3: Verify the shipped file set**

```bash
npm pack --dry-run
```

Expected: the tarball lists `manifest.json`, `dist/index.js`, `README.md`, `icon.png`, `LICENSE`, `package.json` — no `src/`, no tests.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README — setup, scope, privacy and rate-limit notes"
```

---

## Verification checklist (whole plan)

- `npx jest` — all suites green.
- `npx tsc --noEmit` — clean.
- `node build.mjs` — bundles without externals beyond `bufferutil`/`utf-8-validate`.
- `manifest.json` caps are exactly `["net", "query"]`; doc types `telegram.chat_day` / `telegram.file`.
- `src/kiagent-contracts.ts` byte-identical to the WhatsApp connector's copy (`diff` it).
- Spec coverage: connect (user creds + QR + 2FA) ✔ Task 9; dialog scope ✔ Task 5; full-history resumable walker + catch-up ✔ Task 7; live merge + debounce ✔ Task 8; media window/cap/refs ✔ Tasks 4+8; fetchBytes ✔ Task 9; 401 auth-loss ✔ Tasks 8+9; flood handling ✔ Task 7; bundle gate ✔ Task 10; README risk/privacy notes ✔ Task 11.

