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
