// For whoever runs this server, at its own PC: a way back in when the owner's local account's
// password is forgotten, which the admin page can't help with (see server/lib/localusers.js).
//
//   npm run local-account -- list                  the local accounts
//   npm run local-account -- password <username>   sets a new password (asked for, not echoed)
//   npm run local-account -- off                   turns local accounts off: with no Google
//                                                  sign-in, everyone on the local network is
//                                                  the owner again
//
// It edits the files in userdata/ directly, so restart the server afterwards: a running one
// keeps its own copy and would write over the change.

import path from 'node:path';
import readline from 'node:readline';
import { userdataDir } from '../server/lib/datadir.js';
import { LocalUsers, localEmail, localUsername, passwordProblem } from '../server/lib/localusers.js';
import { ServerSettings } from '../server/lib/settings.js';
import { Auth } from '../server/lib/auth.js';

const userdata = userdataDir;
const [command, username] = process.argv.slice(2);

/**
 * Asks each question in turn, without showing what's typed, and returns the answers. One reader
 * for all of them: a reader each would lose the lines typed (or piped in) ahead of its turn.
 */
async function askHidden(...questions) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  // Nothing typed is echoed; the questions are written here instead.
  rl._writeToOutput = () => {};
  // Lines are kept until they're asked for, so ones that came in early (piped) aren't lost.
  const lines = rl[Symbol.asyncIterator]();
  const answers = [];
  for (const question of questions) {
    process.stdout.write(question);
    const { value, done } = await lines.next();
    process.stdout.write('\n');
    answers.push(done ? '' : value);
  }
  rl.close();
  return answers;
}

const users = await new LocalUsers(path.join(userdata, 'local-users.json')).load();
// The sessions, to sign accounts out (a new password's uid ends them anyway: this clears the file).
const sessions = new Auth({ file: path.join(userdata, 'sessions.json') });

if (command === 'list') {
  if (!users.size) console.log('There are no local accounts.');
  for (const u of users.list()) console.log(`${u.username}${u.owner ? ' (owner)' : ''}  ${u.name}  made ${u.created ?? '?'}`);
} else if (command === 'password' && username) {
  if (!users.has(username)) {
    console.error(`There's no local account called "${username}". "list" shows them.`);
    process.exit(1);
  }
  const [password, again] = await askHidden(`New password for ${username}: `, 'Again: ');
  if (password !== again) {
    console.error('The two passwords aren\'t the same; nothing was changed.');
    process.exit(1);
  }
  const problem = passwordProblem(password, { username });
  if (problem) {
    console.error(`${problem} Nothing was changed.`);
    process.exit(1);
  }
  await users.setPassword(username, password);
  const ended = await sessions.endSessions(localEmail(username));
  console.log(`${localEmail(username)} has a new password and is signed out everywhere (${ended} session(s)). Restart the server now, before anything else is changed on it.`);
} else if (command === 'off') {
  const settings = new ServerSettings(path.join(userdata, 'server.json'));
  await settings.load();
  await settings.update({ localLogins: false });
  // Every local account is signed out, so turning them on again doesn't bring the sessions back.
  const ended = await sessions.endSessions((email) => Boolean(localUsername(email)));
  console.log(`Local accounts are off, and ${ended} local session(s) ended. Restart the server now.`);
} else {
  console.log('Usage:\n  npm run local-account -- list\n  npm run local-account -- password <username>\n  npm run local-account -- off');
  process.exit(command ? 1 : 0);
}
