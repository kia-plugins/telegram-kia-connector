import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Api, utils } from 'teleproto';

import type { DocumentInput, HostFor, SendIntent } from '@kiagent/connector-sdk';
import { saveAuthBlob, type AuthBlob } from '../auth';
import { makeTelegramClient, type TgClient } from '../client';
import { inputPeerFor } from '../media';
import { outboundFor, parseOutboundRef } from '../outbound';
import { createTelegramSender } from '../sender';
import { createTelegramSource, type TelegramHost } from '../source';
import type { ChatInfo, NormalizedMessage } from '../types';

const CHAT: ChatInfo = {
  chatId: '-1001234567890',
  name: 'Team',
  type: 'group',
  peer: { peer: 'channel', accessHash: '987654321' },
};
const MSGS: NormalizedMessage[] = [
  { id: '11', tsMs: Date.UTC(2026, 8, 30, 9, 5), sender: 'Alice', text: 'hi', system: false },
  { id: '12', tsMs: Date.UTC(2026, 8, 30, 9, 6), sender: null, text: 'pinned a message', system: true },
];

describe('telegram reply targets', () => {
  it('a day doc stores the chat (peer + hash) and one target per real message, replyTo as a number', () => {
    const out = outboundFor(CHAT, MSGS) as {
      ref: unknown;
      display: string;
      targets: Array<{ key: string; ref: { replyTo: unknown }; display: string }>;
    };
    expect(out.ref).toEqual({ chatId: '-1001234567890', peer: 'channel', accessHash: '987654321' });
    expect(out.display).toBe('Team');
    expect(out.targets.map((t) => t.key)).toEqual(['11']); // system message skipped
    expect(out.targets[0].ref).toEqual({ ...(out.ref as object), replyTo: 11 });
    expect(out.targets[0].display).toMatch(/^Team \(reply to Alice · \d\d:\d\d\)$/);
    // teleproto's own conversion accepts what we store — and would reject
    // the string form the ledger keeps.
    expect(utils.getMessageId(out.targets[0].ref.replyTo as number)).toBe(11);
    expect(() => utils.getMessageId('11' as never)).toThrow();
  });

  it('no target when the peer class is unknown, or a user/channel has no access hash', () => {
    expect(outboundFor({ ...CHAT, peer: undefined }, MSGS)).toBeUndefined();
    expect(outboundFor({ ...CHAT, peer: { peer: 'channel' } }, MSGS)).toBeUndefined();
    expect(outboundFor({ ...CHAT, peer: { peer: 'user' } }, MSGS)).toBeUndefined();
    expect(outboundFor({ ...CHAT, chatId: '-555', peer: { peer: 'chat' } }, MSGS)).toBeDefined();
  });

  it('toDocument writes metadata.outbound on day docs', () => {
    const src = createTelegramSource({ self: { id: 'x', dataDir: '/tmp' } } as unknown as TelegramHost);
    const doc = src.toDocument({ kind: 'day', chat: CHAT, day: '2026-09-30', messages: MSGS }) as DocumentInput;
    expect((doc.metadata as { outbound?: { display: string } }).outbound?.display).toBe('Team');
  });

  it('the sender re-validates the stored ref', () => {
    expect(parseOutboundRef({ chatId: '-100', peer: 'channel', replyTo: '11' })).toBeNull();
    expect(parseOutboundRef({ chatId: '-100', peer: 'channel', replyTo: 0 })).toBeNull();
    expect(parseOutboundRef({ chatId: 'x', peer: 'user' })).toBeNull();
    expect(parseOutboundRef({ chatId: '42', peer: 'user', accessHash: '7' })).toEqual({
      chatId: '42',
      peer: 'user',
      accessHash: '7',
    });
  });
});

describe('makeTelegramClient', () => {
  it('the send client makes ONE request attempt, never auto-reconnects, and surfaces FLOOD_WAIT at once; the sync client keeps its defaults', () => {
    const blob = { apiId: 1, apiHash: 'a', session: '' };
    type Knobs = { floodSleepThreshold: number; _requestRetries: number; _autoReconnect: boolean };
    const send = makeTelegramClient(blob, { forSend: true }) as unknown as Knobs;
    const sync = makeTelegramClient(blob) as unknown as Knobs;
    expect([send.floodSleepThreshold, send._requestRetries, send._autoReconnect]).toEqual([0, 1, false]);
    expect([sync.floodSleepThreshold, sync._requestRetries, sync._autoReconnect]).toEqual([300, 5, true]);
  });
});

describe('inputPeerFor', () => {
  it('decodes the marked id by the frozen peer class — a basic group with a 100… id is not a channel', () => {
    const chat = inputPeerFor({ chatId: '-100012345', peer: 'chat' }) as Api.InputPeerChat;
    expect(chat).toBeInstanceOf(Api.InputPeerChat);
    expect(String(chat.chatId)).toBe('100012345');
    const channel = inputPeerFor({ chatId: '-100012345', peer: 'channel', accessHash: '1' }) as Api.InputPeerChannel;
    expect(String(channel.channelId)).toBe('12345');
  });
});

describe('telegram sender', () => {
  const BLOB: AuthBlob = { apiId: 1, apiHash: 'h', session: 'S' };
  const INTENT: SendIntent = {
    accountId: 'acc-1' as never,
    kind: 'reply',
    outboundRef: { chatId: '-1001234567890', peer: 'channel', accessHash: '987654321', replyTo: 11 },
    bodyMarkdown: 'On it',
  };

  function setup(behave: Partial<Record<'connect' | 'sendMessage', () => Promise<unknown>>> = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-send-'));
    saveAuthBlob(path.join(dataDir, 'auth/42.json'), BLOB);
    const host = {
      self: { id: 'kia.telegram', dataDir },
      log: () => {},
      query: {
        accounts: async () => [
          { id: 'acc-1', source: 'telegram', identifier: '42', config: { authFile: 'auth/42.json' } },
        ],
      },
    } as unknown as HostFor<'query'>;
    const calls: { made: Array<{ auth: AuthBlob; opts: unknown }>; sent: unknown[][]; disconnects: number } = {
      made: [],
      sent: [],
      disconnects: 0,
    };
    const client = {
      connect: behave.connect ?? (async () => {}),
      disconnect: async () => {
        calls.disconnects += 1;
      },
      sendMessage: async (...args: unknown[]) => {
        calls.sent.push(args);
        return (behave.sendMessage ?? (async () => ({ id: 77 })))();
      },
    } as unknown as TgClient;
    const makeClient = (auth: AuthBlob, opts: unknown) => {
      calls.made.push({ auth, opts });
      return client;
    };
    return { host, calls, makeClient };
  }

  it('sends through a fresh flood-threshold-0 client built from the account’s session, quoting the target, then disconnects', async () => {
    const { host, calls, makeClient } = setup();
    const s = createTelegramSender(host, { makeClient });
    await expect(s.send(INTENT)).resolves.toEqual({ externalMessageId: '77' });
    expect(calls.made).toEqual([{ auth: BLOB, opts: { forSend: true } }]);
    const [peer, params] = calls.sent[0] as [Api.InputPeerChannel, unknown];
    expect(peer).toBeInstanceOf(Api.InputPeerChannel);
    expect(String(peer.channelId)).toBe('1234567890');
    expect(String(peer.accessHash)).toBe('987654321');
    expect(params).toEqual({ message: 'On it', replyTo: 11 });
    expect(calls.disconnects).toBe(1);
  });

  it('a chat-level target sends without replyTo', async () => {
    const { host, calls, makeClient } = setup();
    const { replyTo: _r, ...chatLevel } = INTENT.outboundRef as Record<string, unknown>;
    await createTelegramSender(host, { makeClient }).send({ ...INTENT, outboundRef: chatLevel });
    expect(calls.sent[0][1]).toEqual({ message: 'On it' });
  });

  it('a FLOOD_WAIT is "rate-limited", nothing sent', async () => {
    const { host, makeClient } = setup({
      sendMessage: async () => {
        throw Object.assign(new Error('Please wait 120 seconds'), { code: 420, seconds: 120 });
      },
    });
    await expect(createTelegramSender(host, { makeClient }).send(INTENT)).rejects.toThrow(
      /^rate-limited: Telegram asked to wait 120 s/,
    );
  });

  it('a refused request (400/403) is "not sent"; an auth loss asks to reconnect', async () => {
    const refused = setup({
      sendMessage: async () => {
        throw Object.assign(new Error('403: CHAT_WRITE_FORBIDDEN'), { code: 403 });
      },
    });
    await expect(
      createTelegramSender(refused.host, { makeClient: refused.makeClient }).send(INTENT),
    ).rejects.toThrow(/^not sent: Telegram refused the message/);
    const lost = setup({
      sendMessage: async () => {
        throw Object.assign(new Error('401: AUTH_KEY_UNREGISTERED'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
      },
    });
    await expect(createTelegramSender(lost.host, { makeClient: lost.makeClient }).send(INTENT)).rejects.toThrow(
      /reconnect the account in Settings$/,
    );
  });

  it('an ambiguous failure after the request went out stays unclassified', async () => {
    const { host, makeClient } = setup({
      sendMessage: async () => {
        throw new Error('Connection closed');
      },
    });
    await expect(createTelegramSender(host, { makeClient }).send(INTENT)).rejects.toThrow(/^Connection closed$/);
  });

  it('a connect failure is "not sent" — the request never started', async () => {
    const { host, calls, makeClient } = setup({
      connect: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(createTelegramSender(host, { makeClient }).send(INTENT)).rejects.toThrow(
      /^not sent: couldn't connect to Telegram/,
    );
    expect(calls.sent).toHaveLength(0);
  });

  it('the deadline disconnects the client, and a connect that finishes late never sends', async () => {
    let finishConnect!: () => void;
    const { host, calls, makeClient } = setup({
      connect: () => new Promise<void>((r) => (finishConnect = r)),
    });
    const s = createTelegramSender(host, { makeClient, deadlineMs: 10 });
    await expect(s.send(INTENT)).rejects.toThrow(/^not sent: couldn't reach Telegram in time/);
    expect(calls.disconnects).toBe(1);
    finishConnect();
    await new Promise((r) => setImmediate(r));
    expect(calls.sent).toHaveLength(0);
  });

  it('the deadline also covers the account lookup: a lookup that returns late never connects or sends', async () => {
    let finishLookup!: (v: unknown) => void;
    const { host, calls, makeClient } = setup();
    const accounts = host.query.accounts;
    (host.query as { accounts: unknown }).accounts = () =>
      new Promise((r) => (finishLookup = r)).then(() => accounts());
    await expect(createTelegramSender(host, { makeClient, deadlineMs: 10 }).send(INTENT)).rejects.toThrow(
      /^not sent: couldn't reach Telegram in time/,
    );
    finishLookup(undefined);
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.made).toHaveLength(0);
    expect(calls.sent).toHaveLength(0);
  });

  it('a send still unanswered at the deadline is reported as unconfirmed (may have been sent)', async () => {
    const { host, calls, makeClient } = setup({ sendMessage: () => new Promise(() => {}) });
    await expect(createTelegramSender(host, { makeClient, deadlineMs: 10 }).send(INTENT)).rejects.toThrow(
      /^Telegram did not confirm the message/,
    );
    expect(calls.disconnects).toBe(1);
  });

  it('refuses before connecting when the ref or the session is missing', async () => {
    const { host, calls, makeClient } = setup();
    const s = createTelegramSender(host, { makeClient });
    await expect(s.send({ ...INTENT, outboundRef: undefined })).rejects.toThrow(/^not sent: /);
    await expect(s.send({ ...INTENT, accountId: 'other' as never })).rejects.toThrow(
      /reconnect the account in Settings$/,
    );
    expect(calls.made).toHaveLength(0);
  });
});
