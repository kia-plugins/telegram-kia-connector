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
