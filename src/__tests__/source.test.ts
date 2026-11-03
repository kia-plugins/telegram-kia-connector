import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { saveAuthBlob, type AuthBlob } from '../auth';
import type { QrSignInParams } from '../client';
import type { AuthChannel, Credentials, Document, Session } from '@kiagent/connector-sdk';
import { buildRef } from '../media';
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
  async sendMessage(): Promise<{ id?: unknown }> { return { id: 0 }; }
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
  async sendMessage(): Promise<{ id?: unknown }> { return { id: 0 }; }
}

/** `vault` is the host's vault row for the account, live: saveCredentials
 *  replaces it, as the real verb does. `events` records save/other order. */
function makeSession(
  over: Partial<{
    config: Record<string, unknown>;
    vault: Credentials | null;
    saveFails: boolean;
    onSave: () => void;
  }> = {},
): {
  session: Session; ctrl: AbortController; logs: string[];
  vault: { current: Credentials | null }; saves: Credentials[];
} {
  const ctrl = new AbortController();
  const logs: string[] = [];
  const vault = { current: over.vault ?? null };
  const saves: Credentials[] = [];
  const session = {
    account: {
      id: 'acc1',
      identifier: '42',
      config: over.config ?? { authFile: 'auth/42.json' },
    },
    signal: ctrl.signal,
    credentials: async () => vault.current,
    saveCredentials: async (c: Credentials) => {
      if (over.saveFails) throw new Error('vault write failed');
      over.onSave?.();
      vault.current = c;
      saves.push(c);
    },
    log: (_l: string, m: string) => { logs.push(m); },
  } as unknown as Session;
  return { session, ctrl, logs, vault, saves };
}

const blob: AuthBlob = { apiId: 123, apiHash: 'h', session: 'S' };
const SECRET_BLOB: AuthBlob = { apiId: 9, apiHash: 'HASH-IN-VAULT', session: 'SESSION-IN-VAULT' };
const secretOf = (b: AuthBlob): Credentials => ({ secret: JSON.stringify(b) });

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
      documentTypes: ['telegram.chat_day', 'file'],
    });
  });
});

describe('connect', () => {
  it('emits the QR after the scan hint (host UI wipes the QR on status)', async () => {
    const { host } = makeHost();
    const client = new FakePairClient();
    const src = createTelegramSource(host, { makeClient: () => client, events: EV });
    const events: Array<{ kind: 'qr' | 'status'; text: string }> = [];
    const channel = {
      oauth: jest.fn(),
      showQr: (qr: string) => { events.push({ kind: 'qr', text: qr }); },
      prompt: jest.fn(async () => ({ apiId: 123, apiHash: 'h' })),
      status: (msg: string) => { events.push({ kind: 'status', text: msg }); },
    } as unknown as AuthChannel;
    await src.connect(channel);
    const qrAt = events.findIndex((e) => e.kind === 'qr');
    const hintAt = events.findIndex(
      (e) => e.kind === 'status' && /Scan with Telegram/.test(e.text),
    );
    expect(qrAt).toBeGreaterThan(hintAt);
  });

  it('pairing returns a secret and leaves dataDir empty', async () => {
    const { host, dataDir } = makeHost();
    const client = new FakePairClient();
    const src = createTelegramSource(host, { makeClient: () => client, events: EV });
    const { channel, qrs } = makeAuthChannel([{ apiId: 123, apiHash: ' h ' }]);
    const res = await src.connect(channel);
    expect(res).toEqual({
      identifier: '42',
      credentials: {
        secret: JSON.stringify({ apiId: 123, apiHash: 'h', session: 'SESSION_STRING' }),
      },
    });
    expect(res).not.toHaveProperty('config');
    expect(qrs[0]).toBe(`tg://login?token=${Buffer.from('tok').toString('base64url')}`);
    expect(fs.readdirSync(dataDir)).toEqual([]);
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
    await expect(drain(src.pull(session, null))).rejects.toMatchObject({
      message: expect.stringContaining('not paired'),
      code: 'auth',
    });
    const { session: s2 } = makeSession(); // config points at a missing file
    await expect(drain(src.pull(s2, null))).rejects.toMatchObject({
      message: expect.stringContaining('not paired'),
      code: 'auth',
    });
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

  it('throws an auth-coded error after auth loss', async () => {
    const { host, dataDir } = makeHost();
    saveAuthBlob(path.join(dataDir, 'auth/42.json'), blob);
    const client = new FakeSyncClient();
    client.messages = [{ id: 1, date: 1750_000_000, message: 'hi' }];
    client.failWalkWith = new Error('AUTH_KEY_UNREGISTERED');
    const src = createTelegramSource(host, { makeClient: () => client, events: EV });
    const { session } = makeSession();
    await expect(drain(src.pull(session, null))).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('pull: the session lives in the vault', () => {
  const syncClient = () => {
    const c = new FakeSyncClient();
    c.messages = [{ id: 1, date: 1750_000_000, message: 'hi', sender: { firstName: 'Ada' } }];
    return c;
  };
  const authPath = (dataDir: string) => path.join(dataDir, 'auth/42.json');

  it('pull with a secret opens the session without reading the file', async () => {
    const { host, dataDir } = makeHost();
    fs.mkdirSync(path.join(dataDir, 'auth'));
    fs.writeFileSync(authPath(dataDir), 'junk that would warn if read');
    const read = jest.spyOn(fs, 'readFileSync');
    const made: AuthBlob[] = [];
    const src = createTelegramSource(host, {
      makeClient: (b) => (made.push(b), syncClient()), events: EV, flushDebounceMs: 5,
    });
    const { session, ctrl, logs } = makeSession({ vault: secretOf(SECRET_BLOB) });
    await drain(src.pull(session, null), () => ctrl.abort());
    const readFile = read.mock.calls.some((c) => String(c[0]) === authPath(dataDir));
    read.mockRestore();
    expect(readFile).toBe(false);
    expect(made[0]).toEqual(SECRET_BLOB);
    expect(logs.join('\n')).not.toContain('junk'); // the file was never parsed
    // a leftover file is removed, unread
    expect(fs.existsSync(authPath(dataDir))).toBe(false);
  });

  it('pull with a file and no secret saves the secret, then removes the file', async () => {
    const { host, dataDir } = makeHost();
    saveAuthBlob(authPath(dataDir), SECRET_BLOB);
    const made: AuthBlob[] = [];
    const src = createTelegramSource(host, {
      makeClient: (b) => (made.push(b), syncClient()), events: EV, flushDebounceMs: 5,
    });
    let fileThereAtSave = false;
    const { session, ctrl, saves } = makeSession({
      vault: { password: 'twofa' },
      onSave: () => { fileThereAtSave = fs.existsSync(authPath(dataDir)); },
    });
    await drain(src.pull(session, null), () => ctrl.abort());
    expect(fileThereAtSave).toBe(true); // saved BEFORE the unlink
    expect(saves).toEqual([{ password: 'twofa', secret: JSON.stringify(SECRET_BLOB) }]);
    expect(fs.existsSync(authPath(dataDir))).toBe(false);
    expect(made[0]).toEqual(SECRET_BLOB);
  });

  it('a failed save keeps the file, so the next pull migrates again', async () => {
    const { host, dataDir } = makeHost();
    saveAuthBlob(authPath(dataDir), SECRET_BLOB);
    const src = createTelegramSource(host, { makeClient: () => syncClient(), events: EV });
    const { session } = makeSession({ saveFails: true });
    await expect(drain(src.pull(session, null))).rejects.toThrow('vault write failed');
    expect(fs.existsSync(authPath(dataDir))).toBe(true);
  });

  it('crash after the save: the next pull removes the leftover file unread', async () => {
    const { host, dataDir } = makeHost();
    saveAuthBlob(authPath(dataDir), blob); // a DIFFERENT, stale session
    const made: AuthBlob[] = [];
    const src = createTelegramSource(host, {
      makeClient: (b) => (made.push(b), syncClient()), events: EV, flushDebounceMs: 5,
    });
    const { session, ctrl, saves } = makeSession({ vault: secretOf(SECRET_BLOB) });
    await drain(src.pull(session, null), () => ctrl.abort());
    expect(made[0]).toEqual(SECRET_BLOB); // the vault wins over the file
    expect(saves).toEqual([]);
    expect(fs.existsSync(authPath(dataDir))).toBe(false);
  });

  it('malformed file with no secret: not paired, file kept', async () => {
    const { host, dataDir } = makeHost();
    fs.mkdirSync(path.join(dataDir, 'auth'));
    fs.writeFileSync(authPath(dataDir), '{"apiId":"nope"}');
    const src = createTelegramSource(host, { events: EV });
    const { session, saves } = makeSession();
    await expect(drain(src.pull(session, null))).rejects.toMatchObject({
      message: expect.stringContaining('not paired'), code: 'auth',
    });
    expect(fs.existsSync(authPath(dataDir))).toBe(true);
    expect(saves).toEqual([]);
  });

  it('a vault row holding only a 2FA password is not paired', async () => {
    const { host } = makeHost();
    const src = createTelegramSource(host, { events: EV });
    const { session } = makeSession({ vault: { password: 'twofa' }, config: {} });
    await expect(drain(src.pull(session, null))).rejects.toMatchObject({ code: 'auth' });
  });

  it('a malformed secret is not paired', async () => {
    const { host } = makeHost();
    const src = createTelegramSource(host, { events: EV });
    const { session } = makeSession({ vault: { secret: 'not json' }, config: {} });
    await expect(drain(src.pull(session, null))).rejects.toMatchObject({ code: 'auth' });
  });

  it('no secret in any log line', async () => {
    const { host, dataDir } = makeHost();
    fs.mkdirSync(path.join(dataDir, 'auth'));
    fs.writeFileSync(authPath(dataDir), '{"apiId":"nope"}');
    const hostLines: string[] = [];
    (host as unknown as { log: (...a: unknown[]) => void }).log = (...a) => hostLines.push(a.join(' '));
    const src = createTelegramSource(host, { events: EV });
    const bad = makeSession({ vault: { secret: JSON.stringify({ ...SECRET_BLOB, apiId: 'x' }) } });
    await drain(src.pull(bad.session, null)).catch(() => {});
    const ok = makeSession({ vault: secretOf(SECRET_BLOB) });
    const src2 = createTelegramSource(host, { makeClient: () => syncClient(), events: EV, flushDebounceMs: 5 });
    await drain(src2.pull(ok.session, null), () => ok.ctrl.abort());
    const all = [...bad.logs, ...ok.logs, ...hostLines].join('\n');
    expect(all).not.toContain('SESSION-IN-VAULT');
    expect(all).not.toContain('HASH-IN-VAULT');
  });
});

describe('prepareExport', () => {
  it('moves the session file into the vault before a join copies it', async () => {
    const { host, dataDir } = makeHost();
    saveAuthBlob(path.join(dataDir, 'auth/42.json'), SECRET_BLOB);
    const src = createTelegramSource(host, { events: EV });
    const saves: Credentials[] = [];
    await src.prepareExport!({
      account: { id: 'acc1', identifier: '42', config: { authFile: 'auth/42.json' } },
      credentials: async () => null,
      save: async (c: Credentials) => { saves.push(c); },
      log: () => {},
    } as never);
    expect(saves).toEqual([secretOf(SECRET_BLOB)]);
    expect(fs.existsSync(path.join(dataDir, 'auth/42.json'))).toBe(false);
  });

  it('does nothing when the vault already holds the session', async () => {
    const { host } = makeHost();
    const src = createTelegramSource(host, { events: EV });
    const save = jest.fn();
    await src.prepareExport!({
      account: { id: 'acc1', identifier: '42', config: {} },
      credentials: async () => secretOf(SECRET_BLOB),
      save,
      log: () => {},
    } as never);
    expect(save).not.toHaveBeenCalled();
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
      type: 'telegram.chat_day',
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
      type: 'file',
      title: 'a.pdf',
      markdown: null,
      parent: { externalId: '42:2026-07-17', type: 'telegram.chat_day' },
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
