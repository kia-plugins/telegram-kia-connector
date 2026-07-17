import { execSync } from 'node:child_process';
import path from 'node:path';

jest.setTimeout(120_000);

const root = path.resolve(__dirname, '..', '..');

describe('bundle', () => {
  it('esbuild output require()s cleanly and activates one source', async () => {
    execSync('node build.mjs', { cwd: root, stdio: 'pipe' });
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const bundled = require(path.join(root, 'dist', 'index.js')) as {
      default?: { activate: (host: unknown) => Promise<unknown> };
      activate?: (host: unknown) => Promise<unknown>;
    };
    const mod = bundled.default ?? bundled;
    expect(typeof mod.activate).toBe('function');
    const host = { self: { id: 'kia.telegram', dataDir: '/tmp' }, log: () => {} };
    const result = (await mod.activate!(host)) as {
      sources: Array<{ descriptor: { id: string; auth: string } }>;
    };
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].descriptor).toMatchObject({
      id: 'telegram',
      auth: 'pairing',
    });
  });
});
