// Playing games in the browser: the player pages (public/play.html for ScummVM,
// public/playdos.html for DOSBox, public/emu/play.html for the consoles, public/mame/play.html
// for arcade games and the Apple IIGS) shown in an iframe.

import { $, h, api, notify } from './util.js';
import { ms, statsLine } from './netstats.js';
import { state } from './state.js';
import { defaultVersion, controllerLayouts } from './settings.js';
import { getDetail } from './details.js';
import { wireTyping, toggleTyping, stopTyping, offerTyping, isTyping as phoneKeyboardUp } from './typing.js';
import { wireTouchButtons, offerTouchButtons, syncTouchButtons, openTouchEditor } from './touchbuttons.js';

const els = {
  player: $('#player'),
  title: $('#player-title'),
  version: $('#player-version'),
  status: $('#player-status'),
  failure: $('#player-crash'),
  failureTitle: $('#player-crash-title'),
  failureText: $('#player-crash-text'),
  leave: $('#player [data-act="leave"]'),
  invite: $('#player [data-act="invite"]'),
  inviteSheet: $('#invite-sheet'),
  inviteLink: $('#invite-link'),
  invitePlayers: $('#invite-players'),
};

const session = {
  run: 0,          // increases with every load of the player frame
  launch: null,    // { g, version, sound, engine, engineName, retried, recorded }
  problem: null,   // the emulator is in trouble: don't ask it to save, and a quit is a crash
  netplayProblem: null, // only the friend's connection went; the game plays on and still saves
  started: false,  // the engine in the current frame is up (its page said 'started')
  leaving: null,   // promise while the page is asked to save before closing
  returnFocus: null, // what had the focus when the game started
  netplay: null,   // hosting for a friend: { code, key, link, guests: [{ player, name, state }], seen }
};

export const isPlaying = () => !els.player.hidden;
const playerFrame = () => $('iframe', els.player);

/**
 * Gives the keyboard back to the game. The game runs in its own document, so a click on the
 * app's bar (or a key pressed while the app has the focus) would otherwise leave the game
 * deaf to the keyboard with nothing on screen to say so.
 */
export const focusGame = () => playerFrame()?.focus();
const engineName = () => session.launch?.engineName ?? 'the emulator';

/** Plays a game's default version in the browser. */
export async function playDefault(g) {
  // The buttons aren't there for an account that can't play; nor is the P shortcut, then.
  if (!state.can.play) return;
  try {
    const detail = state.detail?.id === g.id ? state.detail : await getDetail(g.id);
    const v = defaultVersion(detail);
    if (v) startWebGame(detail, v, v.defaultSound);
    else if (detail.webVersions?.length) notify(`${g.title} doesn't run in the browser yet. Its page has a Try anyway button.`, 'error', 8000);
    else notify(`${g.title} can't be played in the browser.`, 'error');
  } catch (err) {
    notify(`Couldn't start ${g.title}: ${err.message}`, 'error', 8000);
  }
}

// A launch waiting for the server. A second click on Play (or P held down) meanwhile would
// start the game twice, and leave a history entry behind that Back steps onto to no effect.
let launching = false;

/**
 * Starts a version in the browser. With `invite`, a friend can join it: a room is opened on
 * the server and the link to it copied, and the player page streams the game to whoever opens
 * the link, through EmulatorJS's own netplay (see public/emu/play.html, public/js/join.js and
 * server/lib/netplay.js).
 */
export async function startWebGame(g, version, sound, { invite = false } = {}) {
  if (!state.can.play || launching || isPlaying()) return;
  const opener = document.activeElement;
  let info;
  let room = null;
  let askedForLaunch = false;
  launching = true;
  try {
    // The room first, then the link straight to the clipboard: the browser allows that only
    // soon after the click, and the launch details can wait a moment.
    if (invite) {
      room = await api('/netplay/rooms', { method: 'POST', body: { gameId: g.id, versionId: version.id } });
      // At the public address set on the admin page when there is one, otherwise at this one.
      room.linkIsPublic = Boolean(room.link);
      room.link ??= `${location.origin}/join/${room.code}`;
      room.copied = await copyText(room.link);
    }
    askedForLaunch = true;
    info = await api(`/games/${encodeURIComponent(g.id)}/web/${encodeURIComponent(version.id)}?sound=${encodeURIComponent(sound)}`);
  } catch (err) {
    notify(`Couldn't start ${g.title}: ${err.message}`, 'error', 8000);
    // The server couldn't work out how to start this version: a failing game for the owner's
    // list, like one whose player page fails (a lost connection or a refusal isn't, and nor is
    // the tunnel's 502-524 for a PC asleep or a slow answer: only the server's own 500).
    if (askedForLaunch && err.status === 500) {
      api(`/games/${encodeURIComponent(g.id)}/failed`, { method: 'POST', body: { versionId: version.id, started: false, message: err.message } }).catch(() => {});
    }
    return;
  } finally {
    launching = false;
  }
  document.dispatchEvent(new CustomEvent('player:opening'));
  markGameOpen(g.title);
  session.launch = { g, version, sound, engine: info.engine, engineName: info.engineName, retried: false, recorded: false };
  session.netplay = room ? { ...room, mode: version.netplay ?? 'lockstep', guests: [], seen: new Set() } : null;
  renderInvite();
  // Only DOSBox can lock the mouse (see playdos.html); it starts unlocked.
  // A touch screen has no pointer to lock.
  const mouse = $('#player [data-act="mouse"]');
  mouse.hidden = info.engine !== 'dosbox' || matchMedia('(pointer: coarse)').matches;
  // Full screen only where the browser can put a page element in it (not an iPhone's).
  $('#player [data-act="fullscreen"]').hidden = !document.fullscreenEnabled;
  // The phone's keyboard, for DOS and ScummVM games and a computer MAME runs (an Apple IIgs);
  // a computer in EmulatorJS offers it once its page says it has a keyboard (the 'keyboard'
  // message below). Arcade games have none.
  offerTyping(info.engine === 'mame' ? Boolean(version.controls?.computer) : info.engine !== 'emulatorjs');
  // A DOS or arcade game on a phone has on-screen buttons, as a console game has EmulatorJS's.
  offerTouchButtons(info.engine === 'dosbox' || info.engine === 'mame' ? g : null, { engine: info.engine, controls: version.controls ?? null });
  setMouseLock(false);
  // Only a computer with a keyboard of its own offers the keyboard switch, and its page says
  // so once the emulator is up (see public/emu/play.html).
  keysButton().hidden = true;
  setKeyboardMode(false);
  session.problem = null;
  session.netplayProblem = null;
  session.leaving = null;
  session.returnFocus = opener;
  els.title.textContent = g.title;
  els.version.textContent = version.label === g.title ? '' : version.label;
  // The same first line every platform shows; the page then says what it's loading as it goes
  // (see public/player/shell.js), in the same words whichever emulator it is.
  setStatus('Getting the game ready');
  els.failure.hidden = true;
  els.player.hidden = false;
  document.body.classList.add('is-playing');
  // A console game's page is told each player's controller layout (see Settings), and the
  // room it's hosting (in the fragment, which never reaches the server). A DOS game hosted
  // over IPX gets the same fragment (see public/playdos.html).
  const hosting = room ? `#room=${encodeURIComponent(room.code)}&key=${encodeURIComponent(room.key)}&mode=${encodeURIComponent(version.netplay ?? 'lockstep')}` : '';
  loadFrame(info.engine === 'emulatorjs' ? `${info.url}&layouts=${controllerLayouts().join(',')}${hosting}` : `${info.url}${hosting}`);
  document.title = `${g.title} (playing)`;
  if (room) {
    const reach = localReach(room);
    notify(`${room.copied
      ? 'Invite link copied. Send it to a friend: they open it and join as player 2.'
      : 'The invite link is under "Invite link" in the bar. Send it to a friend: they open it and join as player 2.'}${reach ? ` ${reach}` : ''}`, '', reach ? 15000 : 10000);
  }
  // The browser's Back button leaves the game, like the Leave game button.
  history.pushState({ ...history.state, playing: version.id }, '', location.href);
}

/**
 * Starts a launch URL in a brand-new iframe, tagged so its messages can be told apart.
 * Changing an existing iframe's src would add entries to the tab's Back history, so
 * history.back() could step the game frame back instead of leaving the game. A fresh frame
 * also guarantees the previous emulator instance is gone.
 */
function loadFrame(url) {
  session.run++;
  session.started = false;
  const [page, hash] = url.split('#');
  playerFrame()?.remove();
  const frame = h('iframe', { title: 'Game', allow: 'fullscreen; autoplay; gamepad; midi' });
  frame.src = `${page}&run=${session.run}#${hash ?? ''}`;
  // The page is told its on-screen buttons as soon as it can hear them.
  frame.addEventListener('load', syncTouchButtons);
  els.player.insertBefore(frame, els.failure);
  frame.focus();
}

export function closePlayer() {
  if (!isPlaying()) return;
  endPlayTime();
  markGameOpen(null);
  stopTyping();
  offerTouchButtons(null);
  playerFrame()?.remove();
  els.player.hidden = true;
  document.body.classList.remove('is-playing');
  document.dispatchEvent(new CustomEvent('player:closed'));
  // Leaving a game (by any way out) returns the focus to whatever started it, so the P
  // shortcut and Tab carry on from the same place. When that's gone, the game page's Play
  // button or the game's shelf tile stands in.
  const back = session.returnFocus;
  const target = back && back !== document.body && back.isConnected ? back
    : state.view === 'game' ? $('#play-panel .play-button')
    : state.tiles.get(session.launch?.g.id)?.querySelector('a');
  target?.focus({ preventScroll: true });
  session.returnFocus = null;
  leaveFullscreen();
  document.title = state.detail?.title ?? ($('#scope-head h2')?.textContent || 'Retro Game Browser');
  armLeave(false);
  session.netplay = null;
  renderInvite();
}

// ---------- Playing with a friend ----------

/** Copies text to the clipboard, the modern way or the old; says whether it worked. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No clipboard on a plain http:// address (the local network's), where selecting still works.
    const box = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
    box.value = text;
    document.body.append(box);
    box.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* not allowed */ }
    box.remove();
    return ok;
  }
}

/**
 * Without a public address set on the admin page, the invite link is made from the address this
 * app was opened at. When only this PC or this network can open that address, says so (in words
 * to add to what's shown); otherwise null.
 */
function localReach(room) {
  if (room?.linkIsPublic) return null;
  const host = location.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1') {
    return `This link uses this PC's own address, so only this PC can open it. To invite a friend elsewhere, ${state.can.admin ? 'set the public address on the admin page (Server), or ' : ''}open this app at an address they can reach and start the game from there.`;
  }
  const privateIp = /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /^(f[cd][0-9a-f]{2}|fe80):/.test(host);
  // A bare computer name ("gamepc") or a .local one is known only on the local network.
  const localName = host.endsWith('.local') || (!host.includes('.') && !host.includes(':'));
  return privateIp || localName
    ? 'This link uses a local network address, so only someone on the same network can open it.'
    : null;
}

const GUEST_STATES = { connecting: 'joining…', playing: 'playing', reconnecting: 'connection lost, trying again…' };

/** The bar's Invite link button, its sheet and the status line, from what the page reports. */
/** The stats page, as a window of its own: a game whose tab is hidden runs at a crawl, and everyone waits for it. */
export const openStats = () => window.open('/netplay-stats.html', 'rgb-netplay-stats', 'popup,width=980,height=900');

let buildShown = false;
/** The build this app is served from, on the invite sheet, so both sides can compare. */
function showBuild() {
  if (buildShown) return;
  buildShown = true;
  api('/build').then((b) => { $('#invite-build').textContent = `· build ${b.build}`; }).catch(() => {});
}

function renderInvite() {
  const np = session.netplay;
  els.invite.hidden = !np;
  if (!np) {
    toggleInviteSheet(false);
    return;
  }
  showBuild();
  els.inviteLink.value = np.link;
  $('#invite-help').textContent = [np.mode === 'stream'
    ? 'Send this link. Whoever opens it watches this game as a video stream from this PC and plays along as the next player, with their own keyboard or controller, and needs no account. What they see runs a little behind, so it suits slower games. Up to three friends can join.'
    : 'Send this link. Whoever opens it joins this game as the next player, with their own keyboard or controller, and needs no account. Up to three friends can join.',
  localReach(np)].filter(Boolean).join(' ');
  $('#player [data-act="share-link"]').hidden = typeof navigator.share !== 'function';
  const playing = np.guests.filter((g) => g.state === 'playing');
  els.invite.classList.toggle('has-friends', playing.length > 0);
  const own = statsLine(np.stats, { own: true });
  els.invitePlayers.replaceChildren(
    h('li', { class: 'is-playing' }, 'Player 1: you', own && h('span', { class: 'invite-stats' }, ` — ${own}`)),
    ...np.guests.map((g) => {
      const line = statsLine(g.stats);
      return h('li', { class: g.state === 'playing' ? 'is-playing' : '' }, `Player ${g.player}: ${g.name} (${GUEST_STATES[g.state] ?? g.state})`, line && h('span', { class: 'invite-stats' }, ` — ${line}`));
    }),
    // No trailing null: replaceChildren is the DOM's own, not h(), and would write the word
    // "null" into the list once a fourth player fills the game (see room.js).
    ...(np.guests.length < 3 ? [h('li', {}, `Player ${nextPlayer(np)}: waiting for a friend to open the link`)] : []));
  // Only once the game is up does the status line have room for this; before that it says
  // what's loading. A friend's input lag is the number that says how the game feels to them.
  if (session.started && !session.problem && !session.netplayProblem) {
    setStatus(np.guests.length
      ? np.guests.map((g) => `${g.name} is player ${g.player}${g.state === 'playing' ? (g.stats?.lag != null ? ` (${ms(g.stats.lag)} lag)` : g.stats?.ping != null && g.stats?.videoFps != null ? ` (${ms(g.stats.ping)} to press, ${g.stats.videoFps} fps)` : '') : ` (${GUEST_STATES[g.state] ?? g.state})`}`).join(', ')
      : 'Waiting for a friend to open the invite link');
  }
}

const nextPlayer = (np) => [2, 3, 4].find((p) => !np.guests.some((g) => g.player === p)) ?? 4;

function toggleInviteSheet(open = els.inviteSheet.hidden) {
  els.inviteSheet.hidden = !open;
  els.invite.setAttribute('aria-expanded', String(open));
  document.removeEventListener('pointerdown', outsideInvite);
  if (open) {
    document.addEventListener('pointerdown', outsideInvite);
    els.inviteLink.focus();
    els.inviteLink.select();
  }
}

function outsideInvite(e) {
  if (!els.inviteSheet.contains(e.target) && !els.invite.contains(e.target)) toggleInviteSheet(false);
}

/**
 * The Full screen button puts only the game's iframe in full screen, so the status bar and
 * the failure card (outside the iframe) can't be seen until full screen ends.
 */
function leaveFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// Player pages that keep the game's saves in memory until asked to store them: DOSBox (the
// game's own files), EmulatorJS (the console's battery save) and MAME (high scores and settings).
const SAVES_ON_LEAVE = new Set(['dosbox', 'emulatorjs', 'mame']);

/**
 * Closes the game, then drops the "playing" history entry it added. DOSBox and EmulatorJS
 * pages keep the game's saves in memory, so they're asked to store them first, once the game
 * is running (before that there's nothing to store, and nothing answers).
 */
export async function leaveGame() {
  if (!isPlaying()) return;
  if (session.leaving) return session.leaving;
  session.leaving = (async () => {
    if (SAVES_ON_LEAVE.has(session.launch?.engine) && session.started && !session.problem) await askPageToSave();
    closePlayer();
    if (history.state?.playing) {
      state.skipNextPopstate = true;
      history.back();
    }
  })();
  return session.leaving;
}

/** Tells the player page to save, and waits (briefly) for it to say it's done. */
function askPageToSave() {
  const frame = playerFrame();
  if (!frame?.contentWindow) return Promise.resolve();
  setStatus('Saving…');
  return new Promise((resolve) => {
    const timer = setTimeout(done, 8000);
    function done() {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve();
    }
    function onMessage(e) {
      if (e.origin === location.origin && e.data?.source === 'player' && e.data.type === 'left') done();
    }
    window.addEventListener('message', onMessage);
    frame.contentWindow.postMessage({ source: 'app', type: 'leave' }, location.origin);
  });
}

/**
 * Counts a play of the game on the server (in userdata/plays.json; LaunchBox's history is
 * never written) and updates the loaded records, then says so with a 'game:played' event so
 * the shelf and the game page can show it.
 */
async function recordPlay(launch) {
  const { g, version } = launch;
  try {
    const { playId, ...played } = await api(`/games/${g.id}/played`, { method: 'POST', body: { versionId: version.id } });
    startPlayTime(launch, playId);
    for (const record of new Set([g, state.byId.get(g.id), state.detail?.id === g.id ? state.detail : null])) {
      if (record) Object.assign(record, played);
    }
    document.dispatchEvent(new CustomEvent('game:played', { detail: { id: g.id } }));
  } catch {
    // Not worth interrupting the game for: the play just isn't counted.
  }
}

// ---------- Play time ----------
//
// While a game is open the page checks in with the server every half minute, saying whether
// it's on screen, and says when the game is left: that's how long it was played, and who's
// playing right now, on the owner's admin page (see server/lib/playing.js).

const CHECK_IN_EVERY_MS = 30_000;

function startPlayTime(launch, playId) {
  if (!playId) return;
  // Left (or another game started, or this one stopped with its failure card up) before the
  // server answered.
  if (session.launch !== launch || !isPlaying() || !els.failure.hidden) {
    endPlayTime({ playId });
    return;
  }
  launch.playId = playId;
  launch.checkIn = () => api(`/plays/${encodeURIComponent(playId)}/beat`, { method: 'POST', body: { visible: document.visibilityState === 'visible' } })
    // The server no longer knows the play (it restarted, or this page was away for more than
    // half a day): nothing more to say about it. A shorter gap carries on under the same id.
    .catch((err) => { if (err.status === 404 && launch.playId === playId) stopCheckingIn(launch); });
  launch.checkInTimer = setInterval(launch.checkIn, CHECK_IN_EVERY_MS);
}

function stopCheckingIn(launch) {
  clearInterval(launch.checkInTimer);
  launch.playId = null;
  launch.checkIn = null;
}

/** The game was left: says so once. Sent so it gets there even as the page itself closes. */
function endPlayTime(launch = session.launch) {
  const playId = launch?.playId;
  if (!playId) return;
  if (launch.checkInTimer) stopCheckingIn(launch);
  fetch(`/api/plays/${encodeURIComponent(playId)}/end`, { method: 'POST', keepalive: true, headers: { 'X-Requested-With': 'RetroGameBrowser' } }).catch(() => {});
}

const keysButton = () => $('#player [data-act="keys"]');
const isTyping = () => keysButton().getAttribute('aria-pressed') === 'true';

/**
 * Shows what the keys are doing on a computer that has a keyboard as well as a joystick (the
 * C64): working the joystick, which is what most of its games want, or typing on its keyboard,
 * for the ones that ask you to press a key. The button says what pressing it does.
 */
function setKeyboardMode(on) {
  const button = keysButton();
  button.setAttribute('aria-pressed', String(on));
  button.textContent = on ? 'Steer with the keys' : 'Type on the keyboard';
  button.title = on
    ? 'Send the keys back to the joystick, for games you steer'
    : 'Send the keys to the computer\'s own keyboard, for games that ask you to type or press a key';
}

/** Shows the Lock mouse button's state: pressed while the game holds the pointer. */
function setMouseLock(on) {
  const button = $('#player [data-act="mouse"]');
  button.setAttribute('aria-pressed', String(on));
  button.textContent = on ? 'Unlock mouse' : 'Lock mouse';
}
const isMouseLocked = () => $('#player [data-act="mouse"]').getAttribute('aria-pressed') === 'true';

function setStatus(text, tone = '') {
  els.status.textContent = text;
  els.status.className = `player-status${tone ? ` is-${tone}` : ''}`;
}

/** Shows the failure card, which has a way back and shows at every screen width. */
function showFailure(title, text) {
  reportFailure(`${title}. ${text}`);
  endPlayTime();
  leaveFullscreen();
  session.problem = title;
  setStatus('');
  els.failureTitle.textContent = title;
  els.failureText.textContent = text;
  els.failure.hidden = false;
  $('[data-act="back"]', els.failure).focus();
}

/**
 * Tells the server a game failed (once per launch), for the owner's list of games that fail on
 * the admin page. Nothing is shown if the report doesn't get through.
 */
function reportFailure(message) {
  const launch = session.launch;
  if (!launch || launch.failureReported) return;
  launch.failureReported = true;
  api(`/games/${encodeURIComponent(launch.g.id)}/failed`, { method: 'POST', body: { versionId: launch.version.id, started: session.started, message } }).catch(() => {});
}

/**
 * Some eXo game IDs were renamed in newer ScummVM (e.g. Xeen). When the web build doesn't
 * recognise one, relaunch once and let ScummVM detect the game from its files.
 */
function retryWithAutoDetect() {
  const launch = session.launch;
  if (!launch || launch.retried || launch.engine !== 'scummvm') return false;
  launch.retried = true;
  const run = ++session.run; // anything the failed attempt still says is now ignored
  setStatus('Detecting the game…');
  // Left meanwhile (or another game started): the answer is for a player that's gone.
  const stillHere = () => session.run === run && session.launch === launch && isPlaying();
  api(`/games/${encodeURIComponent(launch.g.id)}/web/${encodeURIComponent(launch.version.id)}?sound=${encodeURIComponent(launch.sound)}&auto=1`)
    .then((info) => { if (stillHere()) loadFrame(info.url); })
    .catch((err) => { if (stillHere()) showFailure('This game couldn\'t start', err.message); });
  return true;
}

// Once the game is running, "Leave game" asks once ("Leave game?") and a second click leaves.
// The question stays up while the pointer is on the button, and for a while after, so a slow
// second click (the game can keep the page busy) still counts. Before the game has started,
// one click leaves.
let leaveTimer = 0;
function armLeave(on, ms = 10000) {
  clearTimeout(leaveTimer);
  els.leave.classList.toggle('is-armed', on);
  els.leave.textContent = on ? 'Leave game?' : 'Leave game';
  if (on) {
    els.leave.title = 'Progress since your last in-game save is lost';
    leaveTimer = setTimeout(() => armLeave(false), ms);
  } else {
    els.leave.removeAttribute('title');
  }
}

// A game is marked open in the tab's session storage for as long as it's open. A phone shuts a
// page down without warning when it uses too much memory, and the browser then loads it again,
// back at the game's page with the game gone: the mark still there is how the page knows.
const OPEN_GAME = 'rgb-open-game';

function markGameOpen(title) {
  try {
    if (title) sessionStorage.setItem(OPEN_GAME, title);
    else sessionStorage.removeItem(OPEN_GAME);
  } catch { /* storage turned off: no note after a crash, that's all */ }
}

function tellOfLostGame() {
  let title = null;
  try {
    title = sessionStorage.getItem(OPEN_GAME);
    sessionStorage.removeItem(OPEN_GAME);
  } catch { return; }
  if (title) notify(`${title} stopped unexpectedly: the browser closed the page, most likely because it ran low on memory.`, 'error', 12000);
}

export function wirePlayer() {
  // Checking in at once when the page is hidden or shown again, so the time on screen is exact;
  // and saying the game was left when the whole page goes (a closed tab).
  document.addEventListener('visibilitychange', () => session.launch?.checkIn?.());
  window.addEventListener('pagehide', (e) => {
    // A page kept to come back to (the back/forward cache) may return with the game still
    // open, and ending the play would leave the rest of it uncounted: it only says it's off
    // screen, and its check-ins pick up again if it comes back. One that never does is taken
    // to have left once it stops checking in (see server/lib/playing.js).
    // Going away on purpose isn't a game lost (see markGameOpen); one kept to come back to is
    // marked open again if it does.
    markGameOpen(null);
    const playId = session.launch?.playId;
    if (e.persisted && playId && isPlaying()) {
      fetch(`/api/plays/${encodeURIComponent(playId)}/beat`, {
        method: 'POST', keepalive: true, headers: { 'X-Requested-With': 'RetroGameBrowser', 'Content-Type': 'application/json' }, body: JSON.stringify({ visible: false }),
      }).catch(() => {});
    } else {
      endPlayTime();
    }
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && isPlaying()) markGameOpen(session.launch?.g.title);
  });
  tellOfLostGame();
  wireTyping(playerFrame);
  wireTouchButtons(playerFrame);
  // Keys on the failure card are for its own button. The app hands any other key pressed while
  // a game is up back to the game (see app.js), which here would send Enter or Space into the
  // stopped game's frame before the button could act on it.
  els.failure.addEventListener('keydown', (e) => e.stopPropagation());
  els.leave.addEventListener('pointerenter', () => {
    if (els.leave.classList.contains('is-armed')) clearTimeout(leaveTimer);
  });
  els.leave.addEventListener('pointerleave', () => {
    if (els.leave.classList.contains('is-armed')) armLeave(true, 4000);
  });

  els.player.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'mouse') {
      setMouseLock(els.player.querySelector('[data-act="mouse"]').getAttribute('aria-pressed') !== 'true');
      playerFrame()?.contentWindow?.postMessage({ source: 'app', type: 'mouse-lock', on: isMouseLocked() }, location.origin);
      playerFrame()?.focus();
    }
    if (act === 'keys') {
      const on = !isTyping();
      setKeyboardMode(on);
      playerFrame()?.contentWindow?.postMessage({ source: 'app', type: 'keyboard-mode', on }, location.origin);
      // The keyboard goes back to the game, whichever way its keys are now working.
      playerFrame()?.focus();
    }
    if (act === 'fullscreen') {
      const frame = playerFrame();
      // The keyboard goes back to the game, not the button just clicked.
      frame?.requestFullscreen?.().then(() => frame.focus(), () => {});
      frame?.focus();
    }
    if (act === 'type') toggleTyping(focusGame);
    if (act === 'touch') openTouchEditor();
    if (act === 'invite') toggleInviteSheet();
    if (e.target.closest('.invite-build a')) {
      e.preventDefault();
      openStats();
    }
    if (act === 'copy-link' && session.netplay) {
      copyText(session.netplay.link).then((ok) => notify(ok ? 'Invite link copied.' : 'Couldn\'t copy the link; select it and copy it yourself.', ok ? '' : 'error'));
    }
    if (act === 'share-link' && session.netplay) {
      navigator.share({ title: `Play ${session.launch?.g.title ?? 'a game'} with me`, text: 'Open this link to join my game as player 2:', url: session.netplay.link }).catch(() => {});
    }
    if (act === 'leave') {
      if (!session.started || els.leave.classList.contains('is-armed')) leaveGame();
      else armLeave(true);
    }
    if (act === 'back') leaveGame();
    // The bar, the title, the space around the game: none of them wants the keyboard. The
    // invite sheet's link does, to be copied.
    if (!act && !phoneKeyboardUp() && !e.target.closest('#invite-sheet')) focusGame();
  });

  // Messages from the player pages.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.source !== 'player' || !isPlaying()) return;
    if (Number(e.data.run) !== session.run) return; // from an earlier attempt
    const { type, line } = e.data;
    if (type === 'started') {
      session.started = true;
      setStatus('');
      renderInvite();
      // The game is up now: the keyboard belongs to it, wherever the focus wandered while
      // it loaded (unless the phone's keyboard is already up for it).
      if (!phoneKeyboardUp()) focusGame();
      // Once per launch: a start after ScummVM's retry with auto-detection is the same play,
      // and a launch that never started isn't one.
      if (session.launch && !session.launch.recorded) {
        session.launch.recorded = true;
        recordPlay(session.launch);
        // What the collection says to do once the game's up ("double click Start"), which is
        // on the game's page too, now that the page is out of sight.
        const advice = session.launch.version?.howToPlay;
        if (advice) notify(advice.replace(/\s*\n+\s*/g, ' '), '', Math.min(30_000, 8000 + advice.length * 60));
      }
    } else if (type === 'progress') setStatus(line);
    else if (type === 'netplay') {
      // Who's joined the game being hosted (see startNetplay in public/emu/play.html).
      if (!session.netplay) return;
      // The room couldn't be opened (or was lost): the game plays on alone, and the bar says so.
      // Kept apart from session.problem, which means the emulator itself is in trouble: the
      // game is still running and its save still matters on the way out (see leaveGame), and
      // quitting it afterwards is a normal quit, not a crash to show a failure card for.
      if (e.data.error || e.data.ended) {
        session.netplayProblem = e.data.error ?? 'The connection for playing with a friend was lost. The game plays on alone.';
        setStatus(session.netplayProblem, 'error');
        return;
      }
      session.netplay.guests = Array.isArray(e.data.guests) ? e.data.guests : [];
      session.netplay.stats = e.data.stats ?? session.netplay.stats ?? null;
      for (const g of session.netplay.guests) {
        const tag = `${g.player}:${g.name}`;
        if (g.state === 'playing' && !session.netplay.seen.has(tag)) {
          session.netplay.seen.add(tag);
          notify(`${g.name} joined as player ${g.player}.`);
        }
      }
      renderInvite();
    }
    else if (type === 'mouse') setMouseLock(Boolean(e.data.on));
    else if (type === 'keyboard') {
      // EmulatorJS keeps the choice with the game, so a game switched to typing comes back
      // that way: the bar shows what the page says it is, not what it was left on.
      // On a phone the keys are only ever typed (the on-screen buttons are the joystick), so the
      // switch isn't offered and what's typed always reaches the computer's own keyboard.
      const onPhone = matchMedia('(pointer: coarse)').matches;
      keysButton().hidden = !e.data.has || onPhone;
      offerTyping(Boolean(e.data.has));
      if (e.data.has && onPhone && !e.data.on) {
        playerFrame()?.contentWindow?.postMessage({ source: 'app', type: 'keyboard-mode', on: true }, location.origin);
      }
      setKeyboardMode(Boolean(e.data.on) || (Boolean(e.data.has) && onPhone));
    }
    else if (type === 'saved') notify(line || 'Game files saved in this browser.', e.data.tone ?? '', e.data.tone === 'error' ? 8000 : 5000);
    else if (type === 'crashed') {
      showFailure('This game stopped',
        session.launch?.engine === 'scummvm'
          ? 'The browser version of ScummVM crashed while running it. This is a fault in that ScummVM build with some game engines, not a problem with your game files.'
          : `The browser version of ${engineName()} stopped while running it${line ? `: ${line}` : '.'}`);
    } else if (type === 'problem') {
      if (/unrecognized game/i.test(line)) {
        if (retryWithAutoDetect()) return;
        showFailure('This game can\'t run here yet',
          'The browser version of ScummVM recognises the game files but doesn\'t include support for this game.');
        return;
      }
      // The game may still be running, so this stays on the status line; it isn't always
      // followed by an 'exit' (an abort, a lost WebGL context), so full screen ends to show it.
      // Nor does every page send one (EmulatorJS never does), so the failure is reported now;
      // a failure card that follows doesn't report it again.
      reportFailure(line);
      session.problem = line;
      setStatus(line, 'error');
      leaveFullscreen();
    } else if (type === 'exit') {
      // A normal quit returns to the game's page; a failed start stays up so the reason shows
      // (unless a failure card, which says more, is already up).
      if (!session.problem) leaveGame();
      else if (els.failure.hidden) showFailure(`${engineName()} stopped`, session.problem);
    }
  });
}
