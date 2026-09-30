import type { ExtensionModule } from '@kiagent/connector-sdk';
import { createTelegramSender } from './sender';
import { createTelegramSource } from './source';

const mod = {
  async activate(host) {
    return {
      sources: [createTelegramSource(host)],
      senders: { telegram: createTelegramSender(host) },
    };
  },
} satisfies ExtensionModule<'net' | 'query' | 'send'>;

export default mod;
module.exports = mod; // dual export — the host child require()s CJS
