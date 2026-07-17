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
  iterDialogs(): AsyncIterable<unknown> { return (async function* () {})(); }
  iterMessages(): AsyncIterable<unknown> { return (async function* () {})(); }
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
    }) as unknown as Record<string, unknown>;
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
    const doc = src.toDocument(item) as unknown as Record<string, unknown>;
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
