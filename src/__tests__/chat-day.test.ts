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
