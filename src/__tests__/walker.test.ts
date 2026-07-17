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

  it('does not shrink the catch-up window when a flood interrupts the pass', async () => {
    // Chat is already complete with newestTsMs=800_000, overlap=100_000, so
    // the intended stop is 700_000. Pass 1 emits 900/880 then floods; pass 2
    // must re-walk from the top using the ORIGINAL stopAt (700_000), not one
    // recomputed from the newestTsMs the flooded pass advanced to (900_000) —
    // otherwise messages in (700_000, 800_000] are silently skipped forever.
    let calls = 0;
    const iter = (_entity: unknown, _params: { offsetId?: number }) => {
      calls += 1;
      return (async function* () {
        if (calls === 1) {
          yield msg(900, 900);
          yield msg(880, 880);
          const err = new Error('FLOOD_WAIT') as Error & { seconds: number };
          err.seconds = 1;
          throw err;
        }
        for (const dateSec of [900, 880, 850, 820, 790, 760, 730, 710, 690]) {
          yield msg(dateSec, dateSec);
        }
      })();
    };
    const { deps, emitted } = makeDeps({
      client: { iterMessages: iter },
      cursor: { chats: { c1: { complete: true, newestTsMs: 800_000 } } },
      catchUpOverlapMs: 100_000,
    });
    await walkChats(deps);
    // Retry re-covers the window down to 710 (>700_000) and stops before 690;
    // duplicated 900/880 from the flooded first pass are expected — day-merge
    // dedups them downstream.
    expect(emitted.map((e) => e.id)).toEqual([
      900, 880, 900, 880, 850, 820, 790, 760, 730, 710,
    ]);
    expect(deps.cursor.chats.c1.newestTsMs).toBe(900_000);
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
