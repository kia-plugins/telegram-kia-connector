/**
 * The pairing blob: user-provided api credentials + the teleproto
 * StringSession. Since 1.2.0 it lives in the host vault as
 * `Credentials.secret` (JSON), so it travels with the login to another device.
 * Before 1.2.0 it was a PLAINTEXT file under the extension's dataDir; that
 * file is read once, to move it into the vault, and then removed.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Credentials } from '@kiagent/connector-sdk';

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

/** The vault form of a blob. */
export const blobSecret = (blob: AuthBlob): string => JSON.stringify(blob);

/** The blob in a vault row, or null: no `secret`, not JSON, or missing fields
 *  (a row holding only a 2FA password is not a session). Never logs. */
export function blobFromCredentials(
  credentials: Credentials | null | undefined,
): AuthBlob | null {
  const raw = credentials?.secret;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw) as Partial<AuthBlob>;
    if (
      typeof v.apiId !== 'number' ||
      typeof v.apiHash !== 'string' ||
      typeof v.session !== 'string' ||
      v.session.length === 0
    ) {
      return null;
    }
    return { apiId: v.apiId, apiHash: v.apiHash, session: v.session };
  } catch {
    return null;
  }
}

/** Removes the pre-1.2.0 session file. A file that is already gone is fine. */
export function removeAuthFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** The vault is authoritative; the file is a one-time source. With a session
 *  in the vault, a leftover file is removed unread. With none, a readable file
 *  is saved into the vault FIRST, then removed, so a crash between the two
 *  migrates again and changes nothing. A missing or malformed file leaves the
 *  account unpaired and the file where it is. A failed save throws and keeps
 *  the file. */
export async function resolveBlob(io: {
  credentials(): Promise<Credentials | null>;
  save(c: Credentials): Promise<void>;
  /** Absolute path of the legacy file, or null when the account names none. */
  file: string | null;
  warn?(msg: string): void;
}): Promise<AuthBlob | null> {
  const creds = await io.credentials();
  const inVault = blobFromCredentials(creds);
  if (inVault) {
    if (io.file) removeAuthFile(io.file);
    return inVault;
  }
  if (!io.file) return null;
  const fromFile = loadAuthBlob(io.file, io.warn);
  if (!fromFile || fromFile.session.length === 0) return null;
  await io.save({ ...(creds ?? {}), secret: blobSecret(fromFile) });
  removeAuthFile(io.file);
  return fromFile;
}
