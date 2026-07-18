/**
 * The persisted pairing blob: user-provided api credentials + the teleproto
 * StringSession. Stored PLAINTEXT under the extension's dataDir (same
 * trade-off as the WhatsApp connector — documented in the README): anyone
 * with the file can read the account until the session is revoked from
 * Telegram's Settings → Devices.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface AuthBlob {
  apiId: number;
  apiHash: string;
  session: string;
}

export function saveAuthBlob(file: string, blob: AuthBlob): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(blob));
}

/** null on missing or malformed — caller treats both as "not paired". */
export function loadAuthBlob(
  file: string,
  warn?: (msg: string) => void,
): AuthBlob | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // missing file is the normal never-paired case
  }
  try {
    const v = JSON.parse(raw) as Partial<AuthBlob>;
    if (
      typeof v.apiId !== 'number' ||
      typeof v.apiHash !== 'string' ||
      typeof v.session !== 'string'
    ) {
      throw new Error('missing fields');
    }
    return { apiId: v.apiId, apiHash: v.apiHash, session: v.session };
  } catch {
    warn?.(`telegram: auth blob ${path.basename(file)} is malformed — re-pair the account`);
    return null;
  }
}
