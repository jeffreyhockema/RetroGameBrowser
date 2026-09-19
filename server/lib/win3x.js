// Windows 3.x games from eXoWin3x, for the browser build of DOSBox (js-dos).
//
// eXoWin3x differs from eXoDOS in one way that matters: its games aren't zipped. Each game is
// an installed folder ("<collection>\<GameDir>\") with its own copy of Windows 3.1, next to the
// same kind of launcher folder ("<collection>\!win3x\<GameDir>\" with a dosbox.conf). The
// browser needs one file, so the server copies the folder into its cache once and sends it as
// an uncompressed zip (see RomCache.packedFolder); the conf is rewritten exactly as for DOS.

/** Whether a launcher's collection folder is the Windows 3.x one ("...\eXoWin3x"). */
export const isWin3xCollection = (collection) => /(^|[\\/])exowin3x$/i.test(collection.replace(/[\\/]+$/, ''));

/**
 * Files left out of the bundle. WIN386.SWP is the swap file Windows leaves behind: eXo's
 * installs carry 6.5 GB of them between them, and Windows makes its own when it starts.
 * (Paging stays on: Win32s, which 874 of the games install, refuses to run without it.)
 */
export const skipInBundle = (name) => /(^|\/)win386\.swp$/i.test(name);

/**
 * A problem that stops an installed Windows game from running in the browser, or null.
 * eXo's collection has installs whose files are all empty; the launcher looks fine, so the
 * folder itself is what tells them apart.
 */
export function win3xIssue({ totalBytes = 0, fileCount = 0, emptyCount = 0, maxBytes = Infinity } = {}) {
  if (!fileCount) return 'This game isn\'t installed in the eXoWin3x folder.';
  // A handful of real files are empty in working installs; a broken install is empty throughout.
  if (totalBytes < 1024 * 1024 || emptyCount > fileCount / 2) {
    return 'This game\'s files in the eXoWin3x folder are empty, so eXo\'s install didn\'t finish.';
  }
  if (totalBytes > maxBytes) {
    return `Too big to load in the browser (${(totalBytes / 1024 ** 3).toFixed(1)} GB of game data would have to fit in memory).`;
  }
  return null;
}
