import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadAuthBlob, saveAuthBlob } from '../auth';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tka-')), 'a', 'blob.json');

describe('auth blob', () => {
  it('round-trips through save/load, creating parent dirs', () => {
    const file = tmp();
    const blob = { apiId: 12345, apiHash: 'abcd', session: '1Aa==' };
    saveAuthBlob(file, blob);
    expect(loadAuthBlob(file)).toEqual(blob);
  });

  it('returns null quietly for a missing file', () => {
    const warn = jest.fn();
    expect(loadAuthBlob(tmp(), warn)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null and warns for malformed content', () => {
    const file = tmp();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"apiId":"nope"}');
    const warn = jest.fn();
    expect(loadAuthBlob(file, warn)).toBeNull();
    expect(warn).toHaveBeenCalled();
    fs.writeFileSync(file, 'not json');
    expect(loadAuthBlob(file, warn)).toBeNull();
  });
});
