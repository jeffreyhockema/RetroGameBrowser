// A game's own files to download, without the page and emulator an offline copy wraps them in
// (see standalone.js): for someone who has an emulator of their own, or wants the files kept.
//
// What that is depends on how the collection keeps the game:
//   a console game    its ROM or disc archive, exactly as it is in the collection
//   an arcade game    its MAME set's zip, as it is (the BIOS and device zips it needs are MAME's
//                     own, and its disk images are too big to be worth a download)
//   a DOS game        its eXoDOS zip, as it is
//   a Windows 3.x game  the folder eXo installed it into, as an uncompressed zip (the server's
//                     copy of it, see RomCache.packedFolder, which is ready once prepared)
//   a ScummVM game    its data folder, as an uncompressed zip

import path from 'node:path';
import { folderListing } from './romcache.js';
import { versionFileName } from './standalone.js';
import { ZipStream, fileSource } from './zipstream.js';

/**
 * How a version's game files download, or null when its files aren't there:
 * { how: 'file', abs, name, bytes } for a file sent as it is, { how: 'bundle', name, bytes } for
 * a Windows game's copy, or { how: 'folder', dir, name, bytes } for a folder zipped on the way.
 * `bytes` is the size as the collection has it (the download is about that).
 */
export function gameFiles(game, version, stats = null) {
  if (version.engine === 'mame') {
    const own = version.files?.find((f) => f.name === `roms/${version.setName}.zip` && f.abs);
    return own ? { how: 'file', abs: own.abs, name: path.basename(own.abs), bytes: own.size } : null;
  }
  if (version.engine === 'emulatorjs') {
    return version.romAbs ? { how: 'file', abs: version.romAbs, name: path.basename(version.romAbs), bytes: version.romSize ?? 0 } : null;
  }
  if (version.engine === 'dosbox' && version.win3x) {
    return version.dataAbs ? { how: 'bundle', name: `${versionFileName(game, version)}.zip`, bytes: version.dataBytes ?? 0 } : null;
  }
  if (version.engine === 'dosbox') {
    return version.zipAbs ? { how: 'file', abs: version.zipAbs, name: path.basename(version.zipAbs), bytes: version.zipSize ?? 0 } : null;
  }
  return version.dir ? { how: 'folder', dir: version.dir, name: `${versionFileName(game, version)}.zip`, bytes: stats?.totalBytes ?? 0 } : null;
}

/**
 * Writes a folder to `out` as an uncompressed zip, its files under a folder named `top`, bar
 * those `skip` turns down (by their path in the folder). Game data is mostly packed already,
 * so storing it costs no more space and leaves the processor alone. Rejects when `out` goes away.
 */
export async function writeFolderZip(dir, top, out, skip = () => false) {
  const listing = await folderListing(dir, skip);
  const zip = new ZipStream(out);
  for (const file of listing.files) {
    await zip.add(`${top}/${file.rel}`, fileSource(path.join(dir, ...file.rel.split('/'))), { size: file.size });
  }
  await zip.finish();
}
