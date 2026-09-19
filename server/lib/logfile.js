// The server's log: everything it writes to its console window, also written to a file. An
// installed copy runs as a Windows service, with no window to read, so this is the only place
// its messages can be seen afterwards (the admin page's Server tab shows the latest).
//
// What goes to stdout and stderr is copied line by line, each line stamped with the local time
// and marked "err" when it went to stderr (console.warn and console.error, and Node's own
// warnings). A crash is written too, since Node prints an uncaught error without going through
// process.stderr. Writes are synchronous, so the last lines before a process.exit() aren't lost.
//
// A file a day, logs/server-YYYY-MM-DD.log; a day past MAX_FILE_BYTES goes on in
// server-YYYY-MM-DD-2.log and so on. Files older than `keepDays` are deleted.

import fs from 'node:fs';
import path from 'node:path';

const KEEP_DAYS = 30;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const NAME = /^server-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.log$/;
// Colours and other terminal escapes, which mean nothing in a file.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;

const pad = (n, width = 2) => String(n).padStart(width, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stampOf = (d) => `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

let current = null;

/**
 * Starts copying the console into `dir`. Returns the log, whose `write(kind, text)` adds lines
 * of its own; calling it again returns the one already started.
 */
export function startLogging(dir, { keepDays = KEEP_DAYS, maxFileBytes = MAX_FILE_BYTES, now = () => new Date(), streams = [[process.stdout, 'out'], [process.stderr, 'err']] } = {}) {
  if (current) return current;
  const log = new LogFile(dir, { keepDays, maxFileBytes, now });
  for (const [stream, kind] of streams) {
    const write = stream.write.bind(stream);
    let partial = '';
    stream.write = (chunk, encoding, cb) => {
      try {
        const text = partial + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8'));
        const end = text.lastIndexOf('\n');
        partial = text.slice(end + 1);
        if (end >= 0) log.write(kind, text.slice(0, end));
      } catch {
        // The log must never stop the console from working.
      }
      return write(chunk, encoding, cb);
    };
  }
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    log.write('err', `${origin === 'unhandledRejection' ? 'Unhandled rejection' : 'Uncaught exception'}: ${err?.stack ?? err}`);
  });
  current = log;
  return log;
}

export class LogFile {
  constructor(dir, { keepDays = KEEP_DAYS, maxFileBytes = MAX_FILE_BYTES, now = () => new Date() } = {}) {
    this.dir = dir;
    this.keepDays = keepDays;
    this.maxFileBytes = maxFileBytes;
    this.now = now;
    this.fd = null;
    this.day = null;
    this.part = 1;
    this.bytes = 0;
    this.failed = false;
  }

  /** Writes `text`, a line or several, each stamped. */
  write(kind, text) {
    const at = this.now();
    const stamp = `${stampOf(at)} ${kind === 'err' ? 'err' : '   '} `;
    const lines = String(text).replace(ESCAPES, '').split(/\r?\n/);
    const out = `${lines.map((line) => stamp + line).join('\n')}\n`;
    try {
      this.#open(at);
      fs.writeSync(this.fd, out);
      this.bytes += Buffer.byteLength(out);
      this.failed = false;
    } catch (err) {
      // A full disk or a folder the server may not write to: said once on the console, not on
      // every line (which would come back here).
      if (!this.failed) {
        this.failed = true;
        process.stderr.write(`Couldn't write the log in ${this.dir}: ${err.message}\n`);
      }
      this.#close();
    }
  }

  /** The file lines go into, opened (or moved on to the next day's, or the day's next part) as needed. */
  #open(at) {
    const day = dayOf(at);
    if (this.fd !== null && day === this.day && this.bytes < this.maxFileBytes) return;
    if (day !== this.day) {
      this.#close();
      this.day = day;
      fs.mkdirSync(this.dir, { recursive: true });
      // Carries on in the day's last part when the server starts again the same day.
      const parts = this.files().filter((f) => f.day === day).map((f) => f.part);
      this.part = parts.length ? Math.max(...parts) : 1;
      this.prune(at);
    } else {
      this.#close();
      this.part++;
    }
    const file = path.join(this.dir, `server-${day}${this.part > 1 ? `-${this.part}` : ''}.log`);
    this.fd = fs.openSync(file, 'a');
    this.bytes = fs.fstatSync(this.fd).size;
    if (this.bytes >= this.maxFileBytes) this.#open(at);
  }

  #close() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      // Already gone.
    }
    this.fd = null;
  }

  /** The log's files, oldest first: { name, day, part, bytes }. */
  files() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names.map((name) => {
      const m = NAME.exec(name);
      if (!m) return null;
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(this.dir, name)).size;
      } catch {
        return null;
      }
      return { name, day: m[1], part: Number(m[2] ?? 1), bytes };
    }).filter(Boolean).sort((a, b) => a.day.localeCompare(b.day) || a.part - b.part);
  }

  /** Deletes the days older than keepDays. */
  prune(at = this.now()) {
    const oldest = new Date(at);
    oldest.setDate(oldest.getDate() - this.keepDays + 1);
    const keepFrom = dayOf(oldest);
    for (const f of this.files()) {
      if (f.day >= keepFrom) continue;
      try {
        fs.rmSync(path.join(this.dir, f.name), { force: true });
      } catch {
        // In use by something else, say: next time.
      }
    }
  }

  /**
   * The last `count` lines, newest last, read back from the end of the latest files (at most
   * `maxBytes` of them). `errorsOnly`: only the lines marked "err" (a stack trace's lines each are).
   */
  tail(count = 300, { maxBytes = 4 * 1024 * 1024, errorsOnly = false } = {}) {
    const lines = [];
    let budget = maxBytes;
    for (const f of this.files().reverse()) {
      if (lines.length >= count || budget <= 0) break;
      const size = Math.min(f.bytes, budget);
      budget -= size;
      let text = '';
      try {
        const fd = fs.openSync(path.join(this.dir, f.name), 'r');
        try {
          const buffer = Buffer.alloc(size);
          fs.readSync(fd, buffer, 0, size, f.bytes - size);
          text = buffer.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      let own = text.split('\n').filter(Boolean);
      // Read from part-way through the file: its first line is likely cut.
      if (size < f.bytes) own = own.slice(1);
      if (errorsOnly) own = own.filter((line) => line.slice(24, 27) === 'err');
      lines.unshift(...own.slice(-(count - lines.length)));
    }
    return lines;
  }
}

/** The log started by startLogging, or null (tests, scripts). */
export const serverLog = () => current;
