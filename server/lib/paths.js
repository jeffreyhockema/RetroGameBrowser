import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves LaunchBox-relative paths (e.g. "Manuals\ScummVM\Foo.pdf") against the
 * LaunchBox root, falling back to mirror roots when the primary copy is unreadable.
 */
export class PathResolver {
  constructor(primaryRoot, fallbackRoots = []) {
    this.roots = [primaryRoot, ...fallbackRoots].map((r) => path.resolve(r));
  }

  /**
   * Joins a relative path onto a root, refusing anything that escapes it. A colon is refused
   * too: no Windows file name has one, and "GAME.EXE:Zone.Identifier" names a hidden stream of
   * the file (where Windows notes the address it was downloaded from).
   */
  static within(root, rel) {
    // Past an absolute path's drive letter ("R:\…"), that is.
    if (String(rel).replace(path.isAbsolute(rel) ? /^[A-Za-z]:/ : /^$/, '').includes(':')) return null;
    const abs = path.resolve(root, rel);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (abs !== root && !abs.toLowerCase().startsWith(rootWithSep.toLowerCase())) return null;
    return abs;
  }

  /**
   * Absolute path of the first root where `rel` exists, or null. An absolute path is taken as
   * it is only when it lies under one of the roots: anything else (a manual that points at a
   * file in someone's user folder, a \\server\share) isn't served.
   */
  resolve(rel) {
    if (!rel) return null;
    if (path.isAbsolute(rel)) return this.roots.some((root) => PathResolver.within(root, rel)) && this.#readable(rel) ? rel : null;
    for (const root of this.roots) {
      const abs = PathResolver.within(root, rel);
      if (abs && this.#readable(abs)) return abs;
    }
    return null;
  }

  /** Absolute path under the primary root, whether or not it exists. */
  primary(rel) {
    return PathResolver.within(this.roots[0], rel);
  }

  #readable(abs) {
    try {
      fs.accessSync(abs, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}
