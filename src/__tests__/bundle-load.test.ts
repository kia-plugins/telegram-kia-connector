import path from 'node:path';

import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

jest.setTimeout(120_000);

const root = path.resolve(__dirname, '..', '..');

describe('bundle', () => {
  it('esbuild output require()s cleanly and activates one source', async () => {
    await bundleLoadSmoke({
      root,
      selfId: 'kia.telegram',
      sourceIds: ['telegram'],
    });
  });
});
