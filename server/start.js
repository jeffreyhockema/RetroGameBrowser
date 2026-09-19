// Starts the server: its log first (see lib/logfile.js), so whatever follows is kept even when
// there's no console to read (an installed copy runs as a Windows service); then, on a copy that
// hasn't been set up, the setup page (see setup.js), which answers on this PC only until the
// owner has pointed it at their LaunchBox and chosen how people sign in; then the app itself.
//
// `node server/start.js --setup` (npm run setup) goes through the setup page again.

import { startLogging } from './lib/logfile.js';
import { logsDir, dataDir, installed, setupNeeded } from './lib/datadir.js';

startLogging(logsDir);
console.log(`RetroGameBrowser starting (Node ${process.version}, pid ${process.pid})${installed ? `, data in ${dataDir}` : ''}.`);

if (setupNeeded({ force: process.argv.includes('--setup') })) {
  const { runSetup } = await import('./setup.js');
  await runSetup();
  // The config the app reads was loaded before setup wrote it.
  const { reloadConfig } = await import('./config.js');
  reloadConfig();
}
await import('./index.js');
