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
    // Watermark advances only on clean finish: a mid-pass commit (flood/abort)
    // must not shrink a future catch-up window or inflate the stored cursor.
    let maxTsSeen = 0;
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
          if (tsMs > maxTsSeen) maxTsSeen = tsMs;
          sinceCommit += 1;
          if (sinceCommit >= commitEvery) {
            sinceCommit = 0;
            await deps.commitPoint();
          }
        }
        if (!wasComplete) progress.complete = true;
        if (maxTsSeen > progress.newestTsMs) progress.newestTsMs = maxTsSeen;
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
