// Joining a friend's game (see server/lib/netplay.js for the whole idea).
//
// The link the host sent opens this page. It shows who's playing what, takes a name, and on
// Join puts the app's player in a frame, told to join the room. Which player, and what
// "joining" means, depends on the game:
//
//   lockstep/rollback  the console player (public/emu/play.html). EmulatorJS's netplay loads
//                      the host's save state and follows their game frame by frame.
//   stream             the viewer (public/emu/watch.html): the host's game arrives as video.
//   ipx                the DOS player (public/playdos.html). Both copies run here, and the
//                      game's own network menus do the joining (see server/lib/ipx.js).
//
// The frame says how it's going the way it does for the app (see public/player/shell.js), and
// this page shows that on its card and bar.

import { $ } from './util.js';
import { statsLine } from './netstats.js';

const code = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const NAME_KEY = 'rgb-netplay-name';

// What joining means for the player, in the words the card shows.
const HOW_STREAM = "The host's game comes to you as a video stream and your presses go back the same way, so expect a small delay: fine for turn-based and slower games, not for ones that need split-second timing.";
const HOW_LOCKSTEP = "The game loads in this browser and follows the host's.";
const HOW_IPX = "The game loads in this browser and joins the host's over the network it was built for. Once it's up you pick the network game from the game's own menus; the page shows you which options to choose.";
const NOT_STARTED = "The host's game hasn't started yet; you can join and wait for it.";

const els = {
  title: $('#bar-title'),
  player: $('#bar-player'),
  status: $('#bar-status'),
  fullscreen: $('[data-act="fullscreen"]'),
  leave: $('[data-act="leave"]'),
  stage: $('#stage'),
  backdrop: $('#backdrop'),
  card: $('#card'),
  cardTitle: $('#card-title'),
  cardText: $('#card-text'),
  cardNote: $('#card-note'),
  cardName: $('#card-name'),
  name: $('#name'),
  ways: $('#card-ways'),
};

const session = { info: null, frame: null, player: null, started: false, ended: false };

// ---------- The card ----------

function card({ title, text = '', note = '', name = false, ways = [], error = false }) {
  els.card.hidden = false;
  els.card.classList.toggle('is-error', error);
  els.cardTitle.textContent = title;
  els.cardText.textContent = text;
  els.cardText.hidden = !text;
  els.cardNote.textContent = note;
  els.cardNote.hidden = !note;
  els.cardName.hidden = !name;
  els.ways.replaceChildren(...ways.map((way) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = way.label;
    if (way.main) button.classList.add('is-main');
    button.addEventListener('click', way.act);
    return button;
  }));
  els.ways.hidden = !ways.length;
}

function status(text, error = false) {
  els.status.textContent = text;
  els.status.classList.toggle('is-error', error);
}

/** The game is over, one way or another: the frame goes, the card says why. */
function ended(title, text, { error = false } = {}) {
  if (session.ended) return;
  session.ended = true;
  session.frame?.remove();
  session.frame = null;
  els.leave.hidden = true;
  els.fullscreen.hidden = true;
  status('');
  document.exitFullscreen?.().catch(() => {});
  card({ title, text, error, ways: [{ label: 'Try the link again', act: () => location.reload() }] });
}

// ---------- Before joining ----------

async function load() {
  let info;
  try {
    const res = await fetch(`/api/netplay/rooms/${encodeURIComponent(code)}`, { cache: 'no-store' });
    info = await res.json();
    if (!res.ok) throw new Error(info.error || `The server answered ${res.status}`);
  } catch (err) {
    return card({ title: 'No game at this link', text: err.message, error: true });
  }
  session.info = info;
  document.title = `Join ${info.title}`;
  els.title.textContent = info.title;
  if (info.cover && info.gameId) els.backdrop.style.backgroundImage = `url("/api/games/${encodeURIComponent(info.gameId)}/images/${encodeURIComponent(info.cover)}/0?w=960")`;

  // A name to be known by: the one used last time here, or the account signed in.
  let remembered = '';
  try { remembered = localStorage.getItem(NAME_KEY) ?? ''; } catch { /* storage off */ }
  if (!remembered) {
    try {
      const me = await fetch('/api/me', { cache: 'no-store' }).then((r) => r.json());
      remembered = (me.user?.name ?? '').split(' ')[0];
    } catch { /* not signed in, or an old server */ }
  }
  els.name.value = remembered;

  if (info.full) return card({ title: `${info.title} is full`, text: 'Every controller is taken. Ask the host to make room, then try the link again.' });
  const next = Math.max(2, info.players + 1);
  els.name.placeholder = `Player ${next}`;
  // By video (see public/player/netplay-stream.js) the host's game comes as a stream, with the
  // delay that brings; otherwise the game runs here too, in step with the host's.
  const stream = info.mode === 'stream';
  // A DOS game plays over its own LAN protocol (see server/lib/ipx.js): both copies run here,
  // and the game's own menus do the joining, so the player has a little to do themselves.
  const ipx = info.mode === 'ipx';
  card({
    title: `Join ${info.title}`,
    text: `${info.hostName} is playing ${info.title}${info.platform ? ` (${info.platform})` : ''} and has invited you. You'll be player ${next}, with your keyboard${matchMedia('(pointer: coarse)').matches ? ', a controller or the buttons on screen' : ' or a controller'}.`,
    note: `${stream ? HOW_STREAM : ipx ? HOW_IPX : HOW_LOCKSTEP} ${info.open ? '' : NOT_STARTED}`.trim(),
    name: true,
    ways: [{ label: ipx ? 'Join the game' : `Join as player ${next}`, main: true, act: join }],
  });
  els.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  (remembered ? els.ways.querySelector('button') : els.name)?.focus();
}

// ---------- Joining ----------

function join() {
  if (session.frame) return;
  const name = els.name.value.trim();
  try { localStorage.setItem(NAME_KEY, name); } catch { /* storage off */ }
  card({ title: 'Getting the game ready' });
  els.leave.hidden = false;
  // The app's own console player, told to join the room (in the fragment, which never reaches
  // the server). The game files come with the link (see the server's roomGrant).
  const frame = document.createElement('iframe');
  frame.title = 'Game';
  frame.allow = 'fullscreen; autoplay; gamepad';
  const query = new URLSearchParams({ v: session.info.versionId, title: session.info.title, run: '1', layouts: '1,1,1,1' });
  const hash = new URLSearchParams({ join: code, name, mode: session.info.mode ?? 'lockstep' });
  if (session.info.mode === 'ipx') {
    // A DOS game: the app's DOSBox player, told the room but not the host key, which is what
    // makes it the joining side (see public/playdos.html).
    const dos = new URLSearchParams({ v: session.info.versionId, title: session.info.title, run: '1' });
    frame.src = `/playdos.html?${dos}#${new URLSearchParams({ room: code, mode: 'ipx' })}`;
  } else if (session.info.mode === 'stream') {
    // By video, the small viewer (see public/emu/watch.html) rather than the whole emulator.
    frame.src = `/emu/watch.html#${hash}`;
  } else if (session.info.engine === 'mame') {
    // An arcade game: every player runs it in MAME, kept in step by rollback (see public/player/mame-netplay.js).
    frame.src = `/mame/play.html?${query}#${hash}`;
  } else {
    frame.src = `/emu/play.html?${query}#${hash}`;
  }
  session.frame = frame;
  els.stage.append(frame);
  frame.focus();
}

// What the frame says as it goes (see public/player/shell.js, public/emu/play.html and
// public/playdos.html).
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.source !== 'player' || !session.frame) return;
  const { type, line } = e.data;
  if (type === 'progress') card({ title: line });
  else if (type === 'started') {
    session.started = true;
    // An IPX game has nothing left to wait for once its emulator is up: the game itself
    // does the joining, and the player is shown how (see public/playdos.html).
    if (session.info.mode === 'ipx') {
      els.card.hidden = true;
      status('In the game');
    } else {
      card({ title: 'Joining the game', text: 'Waiting for the host.' });
    }
    els.fullscreen.hidden = !document.fullscreenEnabled;
  } else if (type === 'netplay') {
    if (e.data.error) return ended('Couldn\'t join', e.data.error, { error: true });
    if (e.data.ended) return ended('The game has ended', 'The host left the game.');
    if (e.data.player) {
      session.player = e.data.player;
      els.player.textContent = `Player ${e.data.player}`;
      document.title = `${session.info.title} (player ${e.data.player})`;
    }
    if (e.data.syncing) {
      status('Syncing with the host…');
      if (!els.card.hidden) card({ title: 'Syncing with the host', text: 'Loading where the host\'s game is.' });
    } else if (e.data.player && e.data.connected === false) {
      // By video: in the room, the host's stream not yet playing.
      status(`You're player ${e.data.player} · connecting to the host…`);
      if (!els.card.hidden) card({ title: 'Connecting to the host', text: 'The host\'s game is on its way as a video stream.' });
    } else if (e.data.player) {
      els.card.hidden = true;
      status([`You're player ${e.data.player}`, statsLine(e.data.stats)].filter(Boolean).join(' · '));
    }
  } else if (type === 'problem') ended('Couldn\'t start the game', line, { error: true });
  else if (type === 'crashed') ended('This game stopped', line || 'The emulator stopped while running the game.', { error: true });
  // A DOS game quit to DOS (public/playdos.html, which has saved its files by then). A start
  // that ended at once said 'problem' first, and that card stays.
  else if (type === 'exit') ended('The game has ended', `${session.info.title} was closed on this computer. Try the link again to rejoin.`);
});

// ---------- The bar ----------

els.fullscreen.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else session.frame?.requestFullscreen?.().catch(() => {});
  session.frame?.focus();
});
// A window of its own, not a tab: a game whose tab is hidden runs at a frame a second, and
// everyone in the room waits for it.
document.querySelector('[data-act="stats"]').addEventListener('click', () => {
  window.open('/netplay-stats.html', 'rgb-netplay-stats', 'popup,width=980,height=900');
});
els.leave.addEventListener('click', () => {
  ended('You left the game', `${session.info?.title ?? 'The game'} goes on without you.`);
});

load();
