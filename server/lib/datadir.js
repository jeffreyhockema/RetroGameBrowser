// Where this server keeps what it writes: its config file, userdata/ (accounts, favorites,
// plays, the activity log), cache/ and logs/. Run from the project folder that's the project
// folder itself. An installed copy (see installer/) lives in Program Files, which a service
// can't write to, so its service sets RGB_DATA_DIR to a folder of its own under ProgramData.
//
// Nothing here reads a file: the setup page (server/setup.js) decides whether it's needed
// before the config is loaded.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Whether this is an installed copy, run as a service with a data folder of its own. */
export const installed = Boolean(process.env.RGB_DATA_DIR);
export const dataDir = installed ? path.resolve(process.env.RGB_DATA_DIR) : projectRoot;
export const configFile = path.join(dataDir, 'config.local.json');
export const userdataDir = path.join(dataDir, 'userdata');
export const logsDir = path.join(dataDir, 'logs');

// Where the LaunchBox is when the config doesn't say: where LaunchBox's installer puts it, in the
// user's own folder (C:\Users\<name>\LaunchBox; LaunchBox writes to its own folder, so not
// Program Files). An installed copy's service has no user folder of its own, and its setup page
// looks in everyone's.
export const DEFAULT_LAUNCHBOX_ROOT = path.join(os.homedir(), 'LaunchBox');
// The port when the config doesn't say: an installed copy's (keep in step with the installer's
// AppPort and _common.ps1), or a copy run from the project folder.
export const DEFAULT_PORT = installed ? 6502 : 3000;

/**
 * Whether the setup page comes first: an installed copy that hasn't been set up yet, or a copy
 * run from the project folder with no config and no LaunchBox where the default says. A test
 * server's config (RGB_CONFIG) or a LaunchBox named by LB_ROOT counts as set up. `force`: asked
 * for (npm run setup), to go through it again.
 */
export function setupNeeded({ force = false } = {}) {
  if (force) return true;
  if (fs.existsSync(configFile) || process.env.RGB_CONFIG || process.env.LB_ROOT) return false;
  return installed || !fs.existsSync(path.join(DEFAULT_LAUNCHBOX_ROOT, 'Data', 'Platforms.xml'));
}
