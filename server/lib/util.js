// Small helpers shared by the server's modules.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** An email address as it's compared and kept: trimmed and lower-cased. */
export const lowerEmail = (s) => String(s ?? '').trim().toLowerCase();

/** A plain object: not null, not an array. */
export const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * An error a route answers with its message and `status` (400 unless said). `extra` goes on it
 * too: the setup page's step and field, say.
 */
export const invalid = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** Whether an address is this PC's own loopback one (127.x.x.x, ::1, or 127.x as IPv6 maps it). */
export const isLoopback = (ip = '') => /^(127\.|::ffff:127\.)/.test(ip) || ip === '::1';

/** A cookie's value, or null when there's none or it isn't something this server set (a bad escape, say). */
export function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1 || part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * JSON text from `file`, parsed. A byte-order mark (as Notepad and Windows PowerShell write) is
 * skipped, and a mistake names the file.
 */
export function parseJson(text, file) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} isn't valid JSON (${err.message}); fix it or move it aside.`, { cause: err });
  }
}

/**
 * Renames, waiting a moment and trying again while Windows refuses because another program
 * (OneDrive, a virus scanner, the search indexer) has the old file or folder open.
 */
export async function renameWhenFree(from, to, { tries = 6, delayMs = 50 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (i >= tries || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
      await new Promise((resolve) => { setTimeout(resolve, delayMs * i); });
    }
  }
}

const dataPath = (name) => fileURLToPath(new URL(`../data/${name}`, import.meta.url));

/** A file in server/data as text. */
export const dataText = (name) => fs.readFileSync(dataPath(name), 'utf8');

/** A JSON file in server/data, or {} when it isn't there. */
export function dataJson(name) {
  const file = dataPath(name);
  return fs.existsSync(file) ? parseJson(fs.readFileSync(file, 'utf8'), file) : {};
}
