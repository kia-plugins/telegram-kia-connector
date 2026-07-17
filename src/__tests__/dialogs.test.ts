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
