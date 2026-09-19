// A game's page: art, description, facts, Play, the versions table, what's in the box
// (manual, hint books, maps…) and screenshots.

import { $, h, api, imageUrl, formatDate, formatBytes, formatDuration, plural, shortPlatform, notify } from './util.js';
import { state } from './state.js';
import { rankVersions, defaultVersion, hasGameDefault, setGameDefault, isFavorite, setFavorite, controllerLayouts } from './settings.js';
import { startWebGame } from './player.js';

const PLAYABLE_AUDIO = new Set(['mp3', 'ogg', 'oga', 'wav', 'flac', 'm4a', 'opus']);
const SCREENSHOT_TYPES = ['Screenshot - Gameplay', 'Screenshot - Game Title', 'Screenshot - Game Select', 'Screenshot - Game Over', 'Screenshot - High Scores'];
const GALLERY_TYPES = ['Box - Back', 'Box - 3D', 'Box - Front', 'Box - Front - Reconstructed', 'Box - Back - Reconstructed',
  'Disc', 'Cart - Front', 'Advertisement Flyer - Front', 'Advertisement Flyer - Back', 'Fanart - Box - Front',
  'Fanart - Box - Back', 'Fanart - Disc', 'Fanart - Background', 'Banner'];

const music = $('#music');
// `opener` is what had the focus when it opened (a thumbnail, say), which gets it back after.
const lightbox = { el: $('#lightbox'), items: [], index: 0, gameId: null, opener: null };

/** A game's page. `random` says it was opened at random, so it offers the next random game. */
export function renderRoom(g, { shelfHref, random = false }) {
  const bgType = g.slots.background ?? g.slots.screenshot;
  const backdrop = h('div', { class: 'room-backdrop', 'aria-hidden': 'true' });
  // The backdrop is drawn faint under a fade, where 1280 px looks the same as a full-size
  // original at a fraction of the download.
  if (bgType) backdrop.style.backgroundImage = `url("${imageUrl(g.id, bgType, 0, 1280)}")`;

  // The game's own logo where LaunchBox has one, with the title kept for screen readers. On a
  // narrow screen the logo goes and the title takes its place (see app.css).
  const heading = g.slots.clearLogo
    ? [h('h1', { class: 'room-title visually-hidden' }, g.title), h('img', { class: 'room-logo', src: imageUrl(g.id, 'Clear Logo', 0, 960), alt: '' })]
    : [h('h1', { class: 'room-title' }, g.title)];

  const front = g.slots.front;
  const boxArt = front
    ? h('button', { type: 'button', class: 'room-box', 'aria-label': `Enlarge ${front}`, onclick: () => openLightbox(g.id, [{ type: front, n: 0 }], 0) },
        h('img', { src: imageUrl(g.id, front, 0, 640), alt: `${front} art for ${g.title}` }))
    : h('div', { class: 'room-box' });

  const shots = SCREENSHOT_TYPES.flatMap((type) => (g.images[type] ?? []).map((_, n) => ({ type, n })));
  const skip = new Set([front, 'Clear Logo', ...shots.map((s) => s.type)]);
  const gallery = GALLERY_TYPES.flatMap((type) => (g.images[type] ?? []).map((_, n) => ({ type, n })))
    .filter((it) => !(skip.has(it.type) && it.n === 0));

  return h('article', { class: 'room' },
    backdrop,
    h('div', { class: 'room-inner' },
      h('div', { class: 'room-nav' },
        h('a', { class: 'back-link', href: shelfHref, dataset: { back: '' } }, h('span', { 'aria-hidden': 'true' }, '‹ '), 'Back to the list'),
        h('button', { type: 'button', class: 'back-link is-next', onclick: () => document.dispatchEvent(new CustomEvent('game:random')) },
          random ? 'Next Random Game' : 'Random Game', h('span', { 'aria-hidden': 'true' }, ' ›'))),
      h('div', { class: 'room-top' },
        boxArt,
        h('div', { class: 'room-main' },
          ...heading,
          byline(g),
          h('div', { class: 'play-panel', id: 'play-panel' }, playPanel(g)),
          actions(g),
          notes(g),
          facts(g))),
      h('section', { class: 'versions', id: 'versions', 'aria-labelledby': 'versions-title' }, versionsTable(g)),
      inTheBox(g),
      // Empty sections give null, not 0: h() would show a 0 as text.
      videos(g),
      shots.length ? [h('h2', {}, 'Screenshots'), h('div', { class: 'shots' },
        shots.map((s, i) => h('button', { type: 'button', 'aria-label': `Enlarge screenshot ${i + 1}`, onclick: () => openLightbox(g.id, shots, i) },
          pixelImg(imageUrl(g.id, s.type, s.n, 960), ''))))] : null,
      gallery.length ? [h('h2', {}, 'Box, disc and fan art'), h('div', { class: 'gallery-strip' },
        gallery.map((it, i) => h('button', { type: 'button', 'aria-label': `Enlarge ${it.type}`, onclick: () => openLightbox(g.id, gallery, i) },
          h('img', { src: imageUrl(g.id, it.type, it.n, 480), alt: it.type, loading: 'lazy' }))))] : null));
}

/** Re-renders Play and the versions table, e.g. after the version ranking or a default changes. */
export function refreshVersions() {
  const g = state.detail;
  if (!g) return;
  // The music picked on the page, and the control that had the focus, outlast the rebuild:
  // Play reads the music from the table when it's clicked.
  const sounds = [...document.querySelectorAll('#versions select')].map((s) => [s.id, s.value]);
  const focused = document.activeElement;
  const focusedAt = focused?.closest?.('#play-panel, #versions, #download-action, #invite-action') ? controlKey(focused) : null;
  // replaceChildren() would show a false or null as text; h() skips them, so these do too.
  $('#play-panel')?.replaceChildren(...playPanel(g).filter(Boolean));
  $('#versions')?.replaceChildren(...versionsTable(g).filter(Boolean));
  for (const [id, value] of sounds) {
    const select = id && document.getElementById(id);
    if (select && [...select.options].some((o) => o.value === value)) select.value = value;
  }
  // Downloading and Play with a friend follow Play, so they're for the version Play would
  // start, and come or go with it.
  const row = $('#room-actions');
  const put = (old, fresh, before) => {
    if (old && fresh) old.replaceWith(fresh);
    else if (old) old.remove();
    else if (fresh && row) row.insertBefore(fresh, before);
  };
  const musicButton = () => row?.querySelector('.is-music') ?? null;
  put($('#invite-action'), inviteAction(g), $('#download-action') ?? musicButton());
  put($('#download-action'), downloadAction(g), musicButton());
  if (focusedAt && !focused.isConnected) (findControl(focusedAt) ?? $('#play-panel .play-button'))?.focus({ preventScroll: true });
}

/** Enough about a control on the game page to find its stand-in after refreshVersions. */
function controlKey(el) {
  return {
    id: el.id,
    version: el.closest('.version')?.dataset.version,
    area: el.closest('#download-action') ? '#download-action' : el.closest('#play-panel') ? '#play-panel' : null,
    cls: el.classList[0],
  };
}

function findControl({ id, version, area, cls }) {
  if (id) return document.getElementById(id);
  if (version != null) {
    const row = [...document.querySelectorAll('#versions .version')].find((li) => li.dataset.version === version);
    return cls ? row?.querySelector(`.${cls}`) : null;
  }
  // A Download menu's choice goes with the menu, which comes back closed: its button stands in.
  if (area === '#download-action') return $('#download-action > button');
  return area && cls ? $(`${area} .${cls}`) : null;
}

const byline = (g) => h('p', { class: 'room-byline' },
  h('span', { class: 'room-platform' }, shortPlatform(g.platform)),
  [g.year, g.developer].filter(Boolean).join(', '));

// ---------- Play ----------

/** The big Play button for the game's default version (see the versions table for the rest). */
function playPanel(g) {
  // Nothing about playing at all for an account that can't play.
  if (!state.can.play) return [];
  const versions = g.webVersions ?? [];
  if (!versions.length) return [h('p', { class: 'muted' }, `Playing ${g.platform} games from here isn't supported yet.`)];

  const v = defaultVersion(g);
  if (!v) {
    return [
      h('p', { class: 'play-meta' }, h('span', { class: 'play-warning' }, 'This game doesn\'t run in the browser yet. '),
        'You can still try a version from the table below.'),
    ];
  }
  const names = shortNames(rankVersions(versions));
  return [
    h('button', { type: 'button', class: 'play-button', onclick: () => startWebGame(g, v, $(`#sound-${cssId(v.id)}`)?.value ?? v.defaultSound) }, 'Play'),
    h('div', { class: 'play-summary' },
      h('p', { class: 'play-version' }, names.get(v)),
      h('p', { class: 'play-meta' }, versionMeta(v, names.get(v)),
        // A button, not a #versions link: fragment navigation would trigger the router.
        versions.length > 1 ? ['. ', h('button', { type: 'button', class: 'link-button', onclick: () => $('#versions')?.scrollIntoView({ behavior: 'smooth' }) },
          `All ${plural(versions.length, 'version')}`)] : '.'),
      // Something the player should know before starting (no CD music, say).
      v.note && h('p', { class: 'play-meta' }, v.note),
      howToPlay(v.howToPlay)),
  ];
}

/** What the collection tells a player before the game starts ("double click Start"), a paragraph at a time. */
function howToPlay(text) {
  if (!text) return null;
  const [first, ...rest] = text.split(/\n\n+/);
  return h('div', { class: 'how-to-play' },
    h('p', { class: 'play-meta' }, h('strong', {}, 'How to play: '), first),
    ...rest.map((p) => h('p', { class: 'play-meta' }, p)));
}

const cssId = (id) => id.replace(/[^\w-]/g, '_');

/** "CD DOS release, 480 MB of game data, runs in DOSBox". */
function versionMeta(v, name) {
  // "Other" is the kind of a release nothing is known about; it says nothing worth showing.
  const kind = v.kind?.key && v.kind.key !== name && v.kind.key !== 'Other' ? v.kind.key : null;
  return [
    kind && `${kind} release`,
    // A version whose files are missing has no size; its warning says why.
    // A CD game the server hasn't unpacked yet is known only by its packed size.
    v.totalBytes > 0 && `${formatBytes(v.totalBytes)} ${v.packed ? 'packed' : 'of game data'}`,
    v.engineName && `runs in ${v.engineName}`,
  ].filter(Boolean).join(', ');
}

// ---------- Versions ----------

function versionsTable(g) {
  // Versions are what Play and Download choose between: nothing to show an account that can't play.
  if (!state.can.play) return [];
  const versions = rankVersions(g.webVersions ?? []);
  if (!versions.length) return [];
  const names = shortNames(versions);
  const current = defaultVersion(g);
  const custom = hasGameDefault(g);

  const rows = versions.map((v) => {
    const isDefault = v === current;
    const sounds = v.sounds.length > 1
      ? h('select', { id: `sound-${cssId(v.id)}`, 'aria-label': `Music for ${names.get(v)}` },
          v.sounds.map((s) => h('option', { value: s.driver, selected: s.driver === v.defaultSound }, s.label)))
      : null;
    return h('li', { class: `version${isDefault ? ' is-default' : ''}`, dataset: { version: v.id } },
      h('div', { class: 'version-name-cell' },
        h('span', { class: 'version-name' }, names.get(v)),
        h('span', { class: 'version-meta' }, versionMeta(v, names.get(v))),
        v.knownIssue && h('span', { class: 'version-meta is-warning' }, v.knownIssue),
        v.note && h('span', { class: 'version-meta' }, v.note),
        v.howToPlay && h('span', { class: 'version-meta is-how-to-play' }, v.howToPlay)),
      sounds ?? h('span'),
      versions.length > 1
        ? h('button', {
          type: 'button',
          class: 'default-toggle',
          'aria-pressed': String(isDefault),
          title: isDefault ? 'Play starts this version' : 'Make Play start this version for this game',
          onclick: () => {
            if (isDefault) return;
            setGameDefault(g.id, v.id);
            notify(`${names.get(v)} is now the default for ${g.title}.`);
          },
        }, h('span', { class: 'default-mark', 'aria-hidden': 'true' }, isDefault ? '★' : '☆'), isDefault ? 'Default' : 'Set as default')
        : h('span'),
      h('button', { type: 'button', class: 'play-button small', onclick: () => startWebGame(g, v, sounds?.value ?? v.defaultSound) },
        v.knownIssue ? 'Try anyway' : 'Play'));
  });

  return [
    h('h2', { id: 'versions-title' }, versions.length > 1 ? `Versions (${versions.length})` : 'Version'),
    custom ? h('p', { class: 'versions-note' }, 'This game has its own default. ',
      h('button', { type: 'button', class: 'link-button', onclick: () => setGameDefault(g.id, null) }, 'Use your version ranking instead'), '.') : null,
    h('ul', { class: 'version-list' }, rows),
  ];
}

/**
 * Version names without the part they all share: "CD DOS", "Amiga" rather than
 * "Indiana Jones and the Fate of Atlantis (CD DOS)". Falls back to full names when they differ.
 */
function shortNames(versions) {
  // eXo isn't consistent about case ("Day Of the Tentacle" / "Day Of The Tentacle").
  const prefixOf = (label) => {
    const i = label.indexOf(' (');
    return i === -1 ? null : label.slice(0, i).toLowerCase();
  };
  const prefix = prefixOf(versions[0]?.label ?? '');
  const shared = versions.length > 1 && prefix && versions.every((v) => prefixOf(v.label) === prefix);
  return new Map(versions.map((v) => {
    if (!shared) return [v, v.label];
    const rest = v.label.slice(prefix.length).trim();
    // "(CD DOS, Windows), DOS": one folder split by platform; the kind says it better.
    if (/^\([^()]*,[^()]*\),\s*\S/.test(rest) && v.kind?.key) return [v, v.kind.key];
    return [v, rest.replace(/\)\s*,\s*/g, ', ').replace(/[()]/g, '').trim()];
  }));
}

// ---------- In the box ----------

const PLAYABLE_IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']);

// Little pixel drawings, one per kind of file: a page, a picture, a speaker, a browser window.
const ICONS = {
  doc: 'M1 0h7v1H1zM1 1h1v11H1zM2 11h9v1H2zM10 3h1v8h-1zM8 1h1v1H8zM9 2h1v1H9zM7 1h1v3h3v1H7zM3 6h5v1H3zM3 8h6v1H3z',
  picture: 'M0 1h12v1H0zM0 10h12v1H0zM0 2h1v8H0zM11 2h1v8h-1zM8 3h2v2H8zM2 9V8h1V7h1V6h1V5h1v1h1v1h1v1h1V7h1v1h1v1z',
  audio: 'M8 1h1v8H8zM9 1h2v1H9zM10 2h1v2h-1zM5 8h3v3H5zM4 9h1v1H4z',
  web: 'M4 1h4v1H4zM2 2h2v1H2zM8 2h2v1H8zM1 3h1v6H1zM10 3h1v6h-1zM2 9h2v1H2zM8 9h2v1H8zM4 10h4v1H4zM5 2h1v8H5zM2 5h8v1H2z',
};

function icon(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', ICONS[kind]);
  svg.append(path);
  return svg;
}

const itemKind = (ext) => (PLAYABLE_IMAGE.has(ext) ? 'picture' : PLAYABLE_AUDIO.has(ext) ? 'audio' : /^html?$/.test(ext) ? 'web' : 'doc');

/**
 * The game's videos, ready to play where they sit. The first one starts on its own without
 * sound, the way the shelf's dock does; its controls turn the sound on. Most games have one.
 */
function videos(g) {
  if (!g.videoCount) return null;
  return [
    h('h2', {}, g.videoCount > 1 ? `Videos (${g.videoCount})` : 'Video'),
    h('div', { class: 'room-videos' }, Array.from({ length: g.videoCount }, (_, i) => {
      const el = h('video', {
        class: 'room-video',
        src: `/api/games/${g.id}/videos/${i}`,
        controls: true,
        playsinline: true,
        preload: i ? 'metadata' : 'auto',
        ...(i === 0 && { autoplay: true }),
      });
      // The attribute alone doesn't mute an element built here, and an unmuted video won't
      // start on its own.
      if (i === 0) {
        el.muted = true;
        el.play().catch(() => {});
      }
      return el;
    })),
  ];
}

/**
 * What came in the box: the manual and the files in the game's Extras folder (hint books,
 * maps, reference cards…). Most games have none, so the section is left out altogether then.
 */
function inTheBox(g) {
  const items = [];
  if (g.manualExt) items.push({ name: 'Manual', ext: g.manualExt, href: `/api/games/${g.id}/manual` });
  for (const x of g.extras ?? []) items.push({ name: x.name, ext: x.ext, href: `/api/games/${g.id}/extras/${encodeURIComponent(x.id)}` });
  if (!items.length) return null;
  return [
    h('h2', { id: 'box-title' }, 'In the box'),
    h('ul', { class: 'box-items', 'aria-labelledby': 'box-title' }, items.map((it) =>
      h('li', {}, h('a', { class: 'item', href: it.href, target: '_blank', rel: 'noopener', title: `${it.name} (${it.ext.toUpperCase()})` },
        icon(itemKind(it.ext)), h('span', {}, it.name))))),
  ];
}

// ---------- Favorite, music, video ----------

function actions(g) {
  const items = [favoriteButton(g), inviteAction(g), downloadAction(g)].filter(Boolean);
  if (g.music && PLAYABLE_AUDIO.has(g.music.ext)) {
    const btn = h('button', { type: 'button', class: 'action is-music', 'aria-pressed': 'false' }, 'Play music');
    btn.addEventListener('click', () => toggleMusic(g, btn));
    items.push(btn);
  }
  // A game's own videos play further down the page. LaunchBox's links out (Wikipedia, videos
  // on YouTube) aren't offered: the page is about the game as it is here.
  return h('div', { class: 'actions', id: 'room-actions' }, items);
}

/**
 * Play with a friend: starts the version Play would start and makes a link for a friend, who
 * opens it and joins as the next player (see player.js). The game streams from this browser to
 * theirs, so it's for the console games, which run in EmulatorJS (see server/lib/netplay.js).
 */
function inviteAction(g) {
  if (!state.can.play) return null;
  const v = defaultVersion(g);
  // Only console games (the server says which, and how; see CORES in server/lib/emulatorjs.js).
  if (!v || !v.netplay) return null;
  const byVideo = v.netplay === 'stream';
  return h('button', {
    type: 'button',
    class: 'action is-invite',
    id: 'invite-action',
    title: byVideo
      ? 'Start the game and get a link a friend can open to play along, from anywhere, watching your game as a video stream'
      : 'Start the game and get a link a friend can open to join it as player 2, from anywhere',
    onclick: async () => {
      if (byVideo && !(await confirmByVideo(g))) return;
      startWebGame(g, v, $(`#sound-${cssId(v.id)}`)?.value ?? v.defaultSound, { invite: true });
    },
  }, 'Play with a friend');
}

/**
 * Before hosting a game by video (see public/player/netplay-stream.js): what that means for
 * the friend, so nobody starts a fighting game this way and wonders. Resolves to whether to
 * go on.
 */
function confirmByVideo(g) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const close = (ok) => {
      document.removeEventListener('keydown', onKey, true);
      veil.remove();
      // Back to the button that opened it, which a game started from here also returns to.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      resolve(ok);
    };
    // While it's up, the keys are the dialog's alone: the app's own (Escape leaves the game
    // page, P plays) never hear them, and Tab goes round its two buttons. A button's Enter or
    // Space still works, being the browser's own.
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      } else if (e.key === 'Tab') {
        const buttons = [...veil.querySelectorAll('button')];
        const at = buttons.indexOf(document.activeElement);
        const next = at === -1 ? 0 : (at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        e.preventDefault();
        buttons[next].focus();
      }
    };
    const veil = h('div', { class: 'confirm-veil', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-title' },
      h('div', { class: 'confirm-sheet' },
        h('h2', { id: 'confirm-title' }, 'Playing by video'),
        h('p', {}, `On the ${g.platform}, playing with a friend means streaming your game to them as video. Your friend watches the stream and their presses travel back to your PC, so what they see and do runs a fraction of a second behind the game.`),
        h('p', {}, 'That suits turn-based, puzzle, strategy and slower adventure games. It doesn\'t suit games that need split-second timing: platformers, fighting, racing, rhythm or shooters.'),
        h('p', { class: 'confirm-note' }, 'The stream comes from this PC, so it needs a decent upload connection. Your own controls aren\'t affected.'),
        h('div', { class: 'confirm-ways' },
          h('button', { type: 'button', class: 'is-main', onclick: () => close(true) }, 'Play with a friend'),
          h('button', { type: 'button', onclick: () => close(false) }, 'Cancel'))));
    veil.addEventListener('pointerdown', (e) => { if (e.target === veil) close(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(veil);
    veil.querySelector('.is-main').focus();
  });
}

/**
 * Download, for the version Play would start, in either of two ways, picked from a small menu:
 *   an offline copy  the game's page, its art and videos, and a browser engine that runs it from
 *                    a folder with no server and no internet (see server/lib/standalone.js)
 *   game files only  the ROM or zip as the collection has it, or the game's folder zipped (see
 *                    server/lib/gamefiles.js), for an emulator of one's own
 * An offline copy's size is the folder unzipped, which is what people are really deciding
 * about; the zip itself is usually smaller.
 */
function downloadAction(g) {
  if (!state.can.play) return null;
  const v = defaultVersion(g) ?? rankVersions(g.webVersions ?? [])[0];
  if (!v || (v.standaloneBytes == null && !v.files)) return null;

  const toggle = h('button', { type: 'button', class: 'action', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
    'Download', h('span', { class: 'download-caret', 'aria-hidden': 'true' }, '▾'));
  const choice = (label, size, detail, onPick) => h('button', {
    type: 'button',
    class: 'download-choice',
    role: 'menuitem',
    onclick: () => {
      close();
      onPick(toggle);
    },
  }, h('span', { class: 'download-choice-name' }, label, size ? h('span', { class: 'download-choice-size' }, formatBytes(size)) : null),
  h('span', { class: 'download-choice-detail' }, detail));
  const choices = h('div', { class: 'download-choices', role: 'menu', 'aria-label': `Download ${v.label}`, hidden: true },
    // No offline copy of a game that needs the server (a Windows 9x game starts from eXo's Windows disk).
    v.standaloneBytes != null ? choice('Offline copy', v.standaloneBytes, 'Plays from a folder, with no server and no internet', () => downloadOffline(g, v, toggle)) : null,
    v.files ? choice('Game files only', v.files.bytes, v.files.name, () => downloadFiles(g, v, toggle)) : null);
  const menu = h('div', { class: 'download-menu', id: 'download-action' }, toggle, choices);

  // Closes on a pick, a click anywhere else, or Escape (which would otherwise leave the page).
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  function open() {
    choices.hidden = false;
    // On a narrow screen the button can sit far enough right that the menu would run off the
    // edge: it moves left by as much, keeping the page's 16px margin.
    choices.style.removeProperty('left');
    const over = choices.getBoundingClientRect().right - (document.documentElement.clientWidth - 16);
    if (over > 0) choices.style.left = `${-over}px`;
    toggle.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside);
    choices.querySelector('button')?.focus();
  }
  function close() {
    choices.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside);
  }
  toggle.addEventListener('click', () => (choices.hidden ? open() : close()));
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || choices.hidden) return;
    e.stopPropagation();
    close();
    toggle.focus();
  });
  return menu;
}

/** Downloads a version as an offline copy (see downloadAction). */
async function downloadOffline(g, v, button) {
  const sound = $(`#sound-${cssId(v.id)}`)?.value ?? v.defaultSound;
  if (!(await readyOnServer(g, v, button))) return;
  const turn = await packingTurn(g, button);
  if (!turn) return;
  saveFrom(`/api/games/${g.id}/standalone/${encodeURIComponent(v.id)}?sound=${encodeURIComponent(sound)}&layouts=${controllerLayouts().join(',')}&turn=${encodeURIComponent(turn)}`);
  // A big game takes the server a moment to start sending, and nothing happens meanwhile.
  notify(`Packing ${g.title} to play offline. The download starts in a moment.`, '', 8000);
}

/**
 * The server packs two offline copies at a time. Any more wait their turn here, the page asking
 * every few seconds to keep its place, rather than as a download that shows nothing. Resolves
 * with the turn to download on, or null (having said why) when there isn't one.
 */
async function packingTurn(g, button) {
  button.disabled = true;
  let ticket = null;
  let told = null;
  try {
    for (;;) {
      const answer = await api('/downloads/turn', { method: 'POST', body: { ticket } });
      ticket = answer.ticket;
      if (answer.ready) return ticket;
      if (answer.ahead !== told) {
        told = answer.ahead;
        notify(`Waiting to pack ${g.title}: other offline copies are being packed${answer.ahead ? `, and ${plural(answer.ahead, 'more is', 'more are')} waiting ahead of it` : ''}. Keep this page open, and the download starts by itself.`, '', 120_000);
      }
      await new Promise((resolve) => { setTimeout(resolve, 3000); });
    }
  } catch (err) {
    notify(`Couldn't download ${g.title}: ${err.message}`, 'error', 8000);
    return null;
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

/** Downloads a version's own game files (see downloadAction). */
async function downloadFiles(g, v, button) {
  if (!(await readyOnServer(g, v, button))) return;
  saveFrom(`/api/games/${g.id}/files/${encodeURIComponent(v.id)}`);
  notify(`Downloading ${v.files.name}.`, '', 5000);
}

/**
 * A Windows game is copied on the server before either download can be made, which the first
 * time takes longer than a tunnel waits for a download to start; the server says when it's done.
 * Resolves false (having said why) when it couldn't be.
 */
async function readyOnServer(g, v, button) {
  if (!v.prepareUrl) return true;
  button.disabled = true;
  notify(`Getting ${g.title} ready on the server. This happens once, and can take a few minutes.`, '', 8000);
  try {
    let answer;
    do answer = await fetch(v.prepareUrl).then(async (res) => ({ status: res.status, ...(await res.json().catch(() => ({}))) }));
    while (answer.status === 202);
    if (!answer.ready) throw new Error(answer.error || `The server answered ${answer.status}`);
    return true;
  } catch (err) {
    notify(`Couldn't get ${g.title} ready to download: ${err.message}`, 'error', 8000);
    return false;
  } finally {
    button.disabled = false;
  }
}

/**
 * Starts a download. A link rather than location.href: the server sends the file as an
 * attachment, so the page stays where it is, and the file's name comes from the server.
 */
function saveFrom(url) {
  const link = h('a', { href: url, download: '' });
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Marks the game a favorite, or takes the mark off. LaunchBox is only ever read, so the mark
 * is kept in this app's settings; the shelf's Favorites filter counts both (see settings.js).
 * The shelf summary carries what LaunchBox says, so that's what the mark is compared against.
 */
function favoriteButton(g) {
  if (!state.can.favorites) return null;
  const btn = h('button', { type: 'button', class: 'action is-fav', dataset: { game: g.id } });
  btn.addEventListener('click', () => {
    const subject = favSubject(g.id);
    setFavorite(subject, !isFavorite(subject));
    notify(isFavorite(subject) ? `${g.title} is a favorite.` : `${g.title} is no longer a favorite.`);
  });
  paintFavorite(btn);
  return btn;
}

/** The record the mark is compared against: the shelf summary, which carries what LaunchBox says. */
const favSubject = (id) => state.byId.get(id) ?? state.detail ?? { id };

function paintFavorite(btn) {
  const on = isFavorite(favSubject(btn.dataset.game));
  btn.setAttribute('aria-pressed', String(on));
  btn.replaceChildren(h('span', { class: 'fav-mark', 'aria-hidden': 'true' }, on ? '★' : '☆'), on ? 'Favorite' : 'Add to favorites');
}

// One listener for every game page, rather than one added per page and never taken off, which
// would pile up as pages are opened. At most one game page is up, with one such button on it.
document.addEventListener('favorite:changed', (e) => {
  const btn = $('#game-view .action.is-fav');
  if (btn?.dataset.game === e.detail.id) paintFavorite(btn);
});

function toggleMusic(g, btn) {
  if (!music.paused && music.dataset.game === g.id) {
    stopMusic();
    return;
  }
  music.src = `/api/games/${g.id}/music`;
  music.dataset.game = g.id;
  // A pause or a page change before the music starts aborts play(); that isn't a failure.
  music.play()
    .then(() => { btn.textContent = 'Stop music'; btn.setAttribute('aria-pressed', 'true'); })
    .catch((err) => {
      if (err?.name !== 'AbortError') notify(`The music for ${g.title} won't play in this browser.`, 'error');
    });
  music.onended = () => stopMusic();
}

/**
 * Quiets the game page: the music and any video playing on it. A <video> taken out of the page
 * carries on playing, so leaving the page has to stop them rather than just drop them.
 */
export function stopRoomMedia() {
  for (const el of document.querySelectorAll('.room-video')) el.pause();
  stopMusic();
}

function stopMusic() {
  if (!music.src) return;
  music.pause();
  music.removeAttribute('src');
  delete music.dataset.game;
  music.load();
  // The music button itself: the Favorite button beside it is pressed too, on a favorite.
  const btn = $('.actions .is-music[aria-pressed="true"]');
  if (btn) { btn.textContent = 'Play music'; btn.setAttribute('aria-pressed', 'false'); }
}

// ---------- Text ----------

function notes(g) {
  return g.notes && h('div', { class: 'room-notes', id: 'room-notes', tabindex: '-1' },
    g.notes.split(/\n\s*\n/).map((para) => h('p', {}, para.trim())));
}

function facts(g) {
  const rows = [
    ['Developer', g.developer],
    ['Publisher', g.publisher],
    ['Released', formatDate(g.releaseDate)],
    ['Genre', g.genres.join(', ')],
    ['Players', [g.playModes.join(', '), g.maxPlayers > 1 ? `up to ${g.maxPlayers}` : ''].filter(Boolean).join(', ')],
    ['Series', g.series.join(', ')],
    ['Community rating', g.communityRating ? `${g.communityRating.toFixed(1)} of 5 from ${plural(g.communityVotes, 'vote')}` : ''],
    ['ESRB', g.esrb && g.esrb !== 'Not Rated' ? g.esrb : ''],
    ['Also known as', g.alternateNames.join(', ')],
    // LaunchBox's plays and the ones here together; the time played is LaunchBox's.
    ['Played', g.playCount ? [plural(g.playCount, 'time'), formatDuration(g.playTime), g.lastPlayed ? `last on ${playedDate(g.lastPlayed)}` : ''].filter(Boolean).join(', ') : ''],
    ['ScummVM ID', g.scummvmId],
  ].filter(([, v]) => v);
  // Always there (hidden when empty), so refreshFacts() has something to replace.
  return h('dl', { class: 'facts', id: 'room-facts', hidden: !rows.length }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

/**
 * The day a game was last played, in this device's time zone. Unlike release dates (see
 * formatDate), a play is never a year-only date, even on January 1.
 */
function playedDate(iso) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return formatDate(iso);
  return new Date(time).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Shows the open game's facts again, e.g. after playing it here changed its Played line. */
export function refreshFacts() {
  if (state.detail) $('#room-facts')?.replaceWith(facts(state.detail));
}


// ---------- Lightbox ----------

/** Old games render at 320×200; scale those up with hard pixels rather than blur. */
function pixelImg(src, alt) {
  const img = h('img', { src, alt, loading: 'lazy' });
  img.addEventListener('load', () => { if (img.naturalWidth <= 640) img.classList.add('pixelated'); }, { once: true });
  return img;
}

function openLightbox(gameId, items, index) {
  Object.assign(lightbox, { items, index, gameId });
  if (lightbox.el.hidden) lightbox.opener = document.activeElement;
  lightbox.el.hidden = false;
  showLightboxItem();
  $('.lightbox-close', lightbox.el).focus();
}

function showLightboxItem() {
  const it = lightbox.items[lightbox.index];
  const { length } = lightbox.items;
  const stage = $('.lightbox-stage', lightbox.el);
  stage.replaceChildren(pixelImg(imageUrl(lightbox.gameId, it.type, it.n), `${it.type} ${lightbox.index + 1} of ${length}`));
  // Previous, Next and "2 of 9" only when there's more than one to step through.
  for (const el of lightbox.el.querySelectorAll('.lightbox-nav, .lightbox-count')) el.hidden = length < 2;
  $('.lightbox-count', lightbox.el).textContent = length < 2 ? '' : `${lightbox.index + 1} of ${length}`;
}

export const isLightboxOpen = () => !lightbox.el.hidden;

export function closeLightbox() {
  const wasOpen = !lightbox.el.hidden;
  lightbox.el.hidden = true;
  $('.lightbox-stage', lightbox.el).replaceChildren();
  // Otherwise the focus would drop to the top of the page with the hidden Close button.
  if (wasOpen) lightbox.opener?.focus?.({ preventScroll: true });
  lightbox.opener = null;
}

export function stepLightbox(delta) {
  if (lightbox.items.length < 2) return;
  lightbox.index = (lightbox.index + delta + lightbox.items.length) % lightbox.items.length;
  showLightboxItem();
}

export function wireLightbox() {
  lightbox.el.addEventListener('click', (e) => {
    if (e.target === lightbox.el || e.target.closest('.lightbox-close')) closeLightbox();
    else if (e.target.closest('.lightbox-prev')) stepLightbox(-1);
    else if (e.target.closest('.lightbox-next')) stepLightbox(1);
  });

  // A sideways swipe on a touch screen steps too; not with a mouse, whose clicks and drags
  // keep their usual meaning.
  const stage = $('.lightbox-stage', lightbox.el);
  let swipe = null;
  stage.addEventListener('pointerdown', (e) => {
    swipe = e.pointerType !== 'mouse' && e.isPrimary ? { x: e.clientX, y: e.clientY } : null;
  });
  stage.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > 2 * Math.abs(dy)) stepLightbox(dx < 0 ? 1 : -1);
  });
  stage.addEventListener('pointercancel', () => { swipe = null; });
}
