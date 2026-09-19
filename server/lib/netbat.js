// Reading eXo's network.bat, so a DOS game can be started for two people in one click.
//
// eXo did the per-game research already. 235 of the 255 eXoDOS games with IPX turned on carry
// a network.bat next to run.bat, and it always has the same shape: a menu offering "host" or
// "join", the DOSBox plumbing for each (`ipxnet startserver`, or asking for an IP address and
// running `ipxnet connect`), the command that starts that game's multiplayer mode, and a few
// lines of prose telling the player which of the game's own menu items to pick.
//
// In the browser the plumbing is gone — js-dos carries IPX between the players over WebRTC
// (see lib/ipx.js), so nobody types an IP address and nobody forwards a port. What's left is
// the part eXo couldn't automate anyway: the command, and the instructions. This pulls both
// out.
//
// A file that doesn't have the usual shape returns null, and the game is simply offered
// without the one-click start rather than guessed at.

/** Lines that are the batch file talking to itself, not to the game or the player. */
const CONTROL = /^@?(echo\s+(on|off)|cls|pause|choice\b|if\s|goto\b|rem\b|:|set\s|call\s+setip\b|askecho\b|type\s)/i;
/** The DOSBox commands js-dos replaces: starting or joining an IPX network. */
const IPX = /^@?ipxnet\b/i;
/** eXo's own sign-off, which isn't part of starting the game. */
const SIGNOFF = /thanks for playing|press a key|press any key/i;
/**
 * Advice that only applies to eXo's desktop setup: IP addresses, port forwarding, and the
 * running commentary on DOSBox's own IPX server. In the browser none of it is true — js-dos
 * makes the connection — but a step that merely names IPX ("Select IPX Network") is a real
 * one in the game's menus and has to survive, so this matches eXo's sentences, not the word.
 */
const DESKTOP_ONLY = /\bip address\b|\bip\b\s*[:?]|port\s*\(?\s*213|forward|192\.168|internet play|lan play|ipx server has been started|default port/i;

/** The `echo` text of a line, or null. `echo.` is a blank line. */
function echoed(line) {
  const m = /^@?echo(\.|\s+(.*))$/i.exec(line.trim());
  if (!m) return null;
  return m[1] === '.' ? '' : (m[2] ?? '').trim();
}

/** Splits a batch file into its `:label` blocks, plus the unlabelled lines at the top. */
function blocks(text) {
  const out = new Map([['', []]]);
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const label = /^:([A-Za-z0-9_]+)\s*$/.exec(line);
    if (label) {
      current = label[1].toLowerCase();
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    out.get(current).push(line);
  }
  return out;
}

/**
 * One side of the file: the commands that start the game, and the steps the player has to take
 * in the game's own menus. Returns null when the block has no command to run.
 */
function side(lines) {
  const commands = [];
  const steps = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^@?exit\s*$/i.test(line)) break;
    if (IPX.test(line)) continue;
    const text = echoed(line);
    if (text !== null) {
      // eXo lists the in-game menu path after the commands have been set up; keep the useful
      // lines and drop the desktop-only advice and the sign-off.
      if (text && !DESKTOP_ONLY.test(text) && !SIGNOFF.test(text)) steps.push(text);
      continue;
    }
    if (CONTROL.test(line)) continue;
    commands.push(line);
  }
  if (!commands.length) return null;
  // Everything after the last command is the sign-off, not instructions for starting.
  return { commands, steps: tidySteps(steps) };
}

/**
 * eXo writes the steps as a block of prose with a heading line ("Press a key to launch the
 * game. Then choose the following:"). The heading is about a key press the browser doesn't
 * need, so it goes; what's left is the list.
 */
function tidySteps(steps) {
  const out = [];
  for (const step of steps) {
    if (/^note:/i.test(step)) break; // eXo's trailing notes are about WAD files and the like
    if (/then choose the following|launch the game|launch [A-Z]+\s*$/i.test(step)) continue;
    out.push(step.replace(/^press\s+/i, 'Press '));
  }
  return out;
}

/**
 * What a game's network.bat says. Returns
 * `{ host: { commands, steps }, join: { commands, steps } }`, or null when the file isn't one
 * of eXo's usual ones (18 of the 235 differ enough that guessing would be worse than not
 * offering the one-click start).
 */
export function parseNetworkBat(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  // The two things that make this one of eXo's: it starts an IPX server, and it joins one.
  if (!/ipxnet\s+startserver/i.test(text) || !/ipxnet\s+connect/i.test(text)) return null;
  const parts = blocks(text);
  const host = side(parts.get('host') ?? []);
  // The join side runs the game from `:connected`, once `ipxnet connect` has succeeded.
  const join = side(parts.get('connected') ?? []);
  if (!host || !join) return null;
  return { host, join };
}

/**
 * The autoexec for playing a game with a friend: eXo's own start-up, with the single-player
 * launch replaced by the multiplayer one from network.bat.
 *
 * The launch waits for a key press. js-dos brings IPX up as the emulator starts, not before
 * it, so a game launched by the first line of the autoexec can miss the network; eXo's own
 * file pauses at exactly this point too, and the host wants to wait for their friends anyway.
 */
export function multiplayerAutoexec(autoexec, commands, { waitFor = 'Press a key when everyone has joined.' } = {}) {
  const kept = [];
  for (const line of autoexec) {
    // eXo's single-player launch, which the multiplayer commands replace.
    if (/^@?(call\s+)?run(\.bat)?\s*$/i.test(line.trim())) continue;
    kept.push(line);
  }
  // eXo closes DOSBox once the game returns, on the line after the launch this replaces. Left
  // where it is, it would close DOSBox before the multiplayer commands ever ran — which is
  // nearly every game, since 251 of the 253 with IPX turned on end their autoexec this way —
  // so it comes off here and goes back on after them, where it does what it did before.
  const signOff = [];
  while (kept.length && /^@?exit\s*$/i.test(kept[kept.length - 1].trim())) signOff.unshift(kept.pop());
  // The message is echoed by the DOS shell, so the characters it would read as redirection,
  // piping or a variable come out first.
  const message = String(waitFor).replace(/[<>|&^%]/g, '').replace(/\s+/g, ' ').trim();
  return [
    ...kept,
    '@echo.',
    `@echo ${message}`,
    '@pause',
    '@cls',
    ...commands,
    ...signOff,
  ];
}
