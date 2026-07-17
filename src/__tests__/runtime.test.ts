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

  it('a rejected doFlush self-heals: later flushes still work and stop() still closes the queue', async () => {
    const client = new FakeClient();
    client.dialogs = [userDialog('42', 'Ada')];
    // One backfill message gives us a deterministic sync point (drain its
    // batch below) before the live-event flushes we're actually testing —
    // otherwise a live event injected right after start() can race the
    // walker's own empty-chat commitPoint() and land in the wrong flush.
    client.messagesByChat['42'] = [msg(100, 1750_000_000, 'backfilled')];
    const logs: Array<{ level: string; msg: string }> = [];
    let calls = 0;
    const { rt } = makeRuntime({
      client,
      flushDebounceMs: 5,
      loadPriorMessages: async (id) => {
        calls += 1;
        if (calls === 2) throw new Error('boom'); // first LIVE flush (call #1 is backfill's)
        return null;
      },
      log: (level, msg) => { logs.push({ level, msg }); },
    });
    await rt.start();
    expect(await rt.nextBatch()).not.toBeNull(); // drain the backfill batch — sync point
    const newHandler = client.handlers.find((h) => (h.ev as { tag: string }).tag === 'new')!;

    // First live message: its debounced flush calls loadPriorMessages (call
    // #2), which rejects. Give the debounce + rejection handling time to run.
    await newHandler.cb({
      chatId: { toString: () => '42' },
      message: msg(1, 1750_000_500, 'first'),
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(logs.some((l) => l.level === 'error' && l.msg.includes('flush failed'))).toBe(true);

    // Second, LATER message: if the chain were wedged by the first
    // rejection, this flush would never resolve and nextBatch() would hang.
    await newHandler.cb({
      chatId: { toString: () => '42' },
      message: msg(2, 1750_000_600, 'second'),
    });
    const batch = await rt.nextBatch();
    expect(batch).not.toBeNull();
    const day = batch!.items[0] as DayItem;
    expect(day.messages.some((m) => m.id === '2')).toBe(true);

    // stop() must resolve (queue close + disconnect must run) rather than
    // hang forever awaiting a permanently-rejected chain. Race it against a
    // short timer so a wedged chain fails by assertion, not Jest timeout.
    const TIMEOUT = Symbol('timeout');
    const winner = await Promise.race([
      rt.stop().then(() => 'stop' as const),
      new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 500)),
    ]);
    expect(winner).toBe('stop');
    expect(await rt.nextBatch()).toBeNull();
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
