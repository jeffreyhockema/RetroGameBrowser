// The owner's admin page (public/admin.html): what people play and download, who may do what,
// what's going on right now, and the server's caches. Everything comes from /api/admin (see the
// Admin section of server/index.js), which answers the owner only; this page just says so to
// anyone else.

import { $, h, api, notify, count, formatBytes, plural } from './util.js';

const TABS = ['overview', 'live', 'accounts', 'activity', 'server'];
const RANGES = [[1, 'Today'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [365, 'Year'], [0, 'All']];
const LIVE_EVERY_MS = 5000;
const BADGES_EVERY_MS = 20_000;

// Who did something (see WHO in server/lib/activity.js).
const WHO_LONG = {
  owner: 'Owner',
  account: 'Signed in users',
  local: 'Local network, not signed in',
  guest: 'Guests from the internet',
  visitor: 'Internet, not signed in',
  friend: 'Friends invited to a game',
};
const WHO_SHORT = { owner: 'Owner', account: 'Account', local: 'Local network', guest: 'Guest', visitor: 'Visitor', friend: 'Friend' };
const SIGNED_IN = new Set(['owner', 'account']);
const TYPE_LABELS = { visit: 'Visits', play: 'Plays', stop: 'Play time', download: 'Downloads', failed: 'Failures', signin: 'Sign-ins', badsignin: 'Failed sign-ins', host: 'Games hosted', join: 'Friends joining' };
const ACCESS_LABELS = { play: 'Play and download', browse: 'Browse only', blocked: 'Blocked' };

const page = {
  tab: null,
  days: 30,
  liveTimer: 0,
  badgesTimer: 0,
  chartObserver: null,
  cacheSizes: null,  // the caches' sizes once measured on the Server tab: { caches, at }
  logErrors: false,  // the Server tab's log shows only warnings and errors
  // Each panel's latest request: an answer to an older one (a range clicked before the last, a
  // poll that was out when a change was made) is dropped rather than drawn over a newer one.
  seq: { overview: 0, live: 0 },
  acting: 0,         // changes still waiting for the server (see act)
  pointerDown: false,
  activity: { type: '', who: '', q: '', events: [], more: false, seq: 0 },
};

// ---------- Small helpers ----------

const bytes = (n) => (n ? formatBytes(n) : '0');

/** Time played: "2 h 5 min", "12 min", "< 1 min", or "0". */
function duration(seconds) {
  if (!seconds) return '0';
  if (seconds < 60) return '< 1 min';
  const hrs = Math.floor(seconds / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  return hrs ? `${hrs} h${min ? ` ${min} min` : ''}` : `${min} min`;
}
const panel = (name) => $(`#panel-${name}`);

/** "5 min ago", with the full date and time on hover. */
function ago(iso) {
  if (!iso) return h('span', { class: 'muted' }, 'never');
  const t = Date.parse(iso);
  const s = Math.round((Date.now() - t) / 1000);
  const text = s < 60 ? 'just now'
    : s < 3600 ? `${Math.floor(s / 60)} min ago`
      : s < 86400 ? `${Math.floor(s / 3600)} h ago`
        : s < 2 * 86400 ? 'yesterday'
          : s < 14 * 86400 ? `${Math.floor(s / 86400)} days ago`
            : new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return h('time', { datetime: iso, title: new Date(t).toLocaleString() }, text);
}

const shortDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** A browser's user-agent string as "Chrome on Windows". */
function browserOf(ua = '') {
  if (!ua) return '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
        : /OPR\//.test(ua) ? 'Opera'
          : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari'
              : /node|curl|bot|spider|crawl/i.test(ua) ? 'A program' : 'A browser';
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /CrOS/.test(ua) ? 'ChromeOS'
            : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
              : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function table(head, rows, { empty = 'Nothing yet.' } = {}) {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, head.map((c) => (typeof c === 'string' ? h('th', {}, c) : h('th', c.attrs, c.text))))),
    h('tbody', {}, rows)));
}

const card = (title, sub, ...body) => h('section', { class: 'card' }, h('h2', {}, title), sub ? h('p', { class: 'sub' }, sub) : null, ...body);

/**
 * Replaces a panel's contents but keeps the reader's place in it: the focused control, found
 * again by its data-key, and each table's sideways scroll, which a phone needs for the last
 * columns.
 */
function rebuild(el, ...children) {
  const focused = el.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
  const scrolls = [...el.querySelectorAll('.table-wrap')].map((w) => w.scrollLeft);
  el.replaceChildren(...children.filter(Boolean));
  const wraps = el.querySelectorAll('.table-wrap');
  // Matched up by order, so only while the same tables are there (a card may come or go).
  if (wraps.length === scrolls.length) wraps.forEach((w, i) => { if (scrolls[i]) w.scrollLeft = scrolls[i]; });
  if (focused) [...el.querySelectorAll('[data-key]')].find((x) => x.dataset.key === focused)?.focus({ preventScroll: true });
}

/** Whether the owner is in the middle of something on a panel that a timed refresh would undo. */
function interacting(el) {
  const selection = getSelection();
  return page.acting > 0 || page.pointerDown || (selection && !selection.isCollapsed && el.contains(selection.anchorNode));
}

function errorIn(el, err) {
  el.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'bad' }, `Couldn't load this: ${err.message}`), h('button', { class: 'button', type: 'button', onclick: () => show(page.tab) }, 'Try again')));
}

/** Runs a change, disabling its button meanwhile, and says how it went. */
async function act(button, work, done) {
  if (button) button.disabled = true;
  page.acting++;
  try {
    const result = await work();
    if (done) notify(typeof done === 'function' ? done(result) : done);
    return result;
  } catch (err) {
    notify(err.message, 'error', 8000);
    return null;
  } finally {
    page.acting--;
    if (button?.isConnected) button.disabled = false;
  }
}

// ---------- Tabs ----------

async function start() {
  let me;
  try {
    me = await api('/me');
  } catch (err) {
    return gate('The server didn\'t answer', err.message);
  }
  if (!me.can?.admin) {
    // No accounts: the local network shares the owner's library, but the admin page is this PC's.
    if (me.can?.owner) {
      return gate('Open this page on the PC itself',
        `No sign-in is set up, so the admin page opens only on the PC Retro Game Browser runs on, at http://localhost:${location.port || 80}/admin. To use it from other devices, turn on local accounts or Google sign-in there.`);
    }
    return gate('This page is for the owner',
      me.user ? `You're signed in as ${me.user.email}, which isn't the owner's account.`
        : 'Sign in with the owner\'s account (the round button at the top right of the games page), then open this page again.');
  }
  $('#who').textContent = me.user ? `Signed in as ${me.user.local ? me.user.username : me.user.email}` : 'Owner';
  $('#gate').hidden = true;
  $('#tabs').hidden = false;
  window.addEventListener('hashchange', () => show(tabFromHash()));
  loadBadges();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadBadges();
    if (page.tab === 'live') scheduleLive();
  });
  panel('live').addEventListener('pointerdown', () => { page.pointerDown = true; });
  for (const type of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(type, () => { page.pointerDown = false; });
  show(tabFromHash());
}

/** The counts on the tabs: games being played right now, and new sign-ins to decide about. */
async function loadBadges() {
  clearTimeout(page.badgesTimer);
  try {
    const { playing, newAccounts } = await api('/admin/badges');
    badge('live', playing, `${plural(playing, 'game')} being played`);
    badge('accounts', newAccounts, `${plural(newAccounts, 'new sign-in')}`);
  } catch {
    // Left as they were; tried again shortly.
  }
  // Not while the page is hidden: they're looked at again as soon as it's shown (see start).
  clearTimeout(page.badgesTimer);
  if (!document.hidden) page.badgesTimer = setTimeout(loadBadges, BADGES_EVERY_MS);
}

function badge(tab, n, label) {
  const link = $(`#tabs a[data-tab="${tab}"]`);
  link.querySelector('.badge')?.remove();
  if (n) link.append(h('span', { class: 'badge', title: label, 'aria-label': label }, String(n)));
}

function gate(title, text) {
  $('#gate').replaceChildren(h('h2', {}, title), h('p', {}, text), h('p', {}, h('a', { class: 'button', href: '/' }, 'Back to the games')));
}

const tabFromHash = () => (TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview');

function show(tab) {
  page.tab = tab;
  for (const link of document.querySelectorAll('#tabs a')) {
    if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const el of document.querySelectorAll('[data-panel]')) el.hidden = el.dataset.panel !== tab;
  clearTimeout(page.liveTimer);
  ({ overview: loadOverview, live: loadLive, accounts: loadAccounts, activity: () => loadActivity(), server: loadServer })[tab]();
}

// ---------- Overview ----------

async function loadOverview() {
  const el = panel('overview');
  const my = ++page.seq.overview;
  if (!el.childElementCount) el.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    const { summary } = await api(`/admin/overview?days=${page.days}`);
    if (my === page.seq.overview && page.tab === 'overview') renderOverview(summary);
  } catch (err) {
    if (my === page.seq.overview) errorIn(el, err);
  }
}

const sum = (byWho, only = null) => Object.entries(byWho).filter(([w]) => !only || only(w)).reduce((n, [, v]) => n + v, 0);

function renderOverview(s) {
  const t = s.totals;
  const plays = sum(t.plays);
  const playsSignedIn = sum(t.plays, (w) => SIGNED_IN.has(w));
  const downloads = sum(t.downloads);
  const downloadsSignedIn = sum(t.downloads, (w) => SIGNED_IN.has(w));

  const ranges = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Period' }, RANGES.map(([days, label]) => h('button', {
    type: 'button',
    'aria-pressed': String(page.days === days),
    onclick: () => { page.days = days; loadOverview(); },
  }, label)));

  const tile = (label, value, detail) => h('div', { class: 'tile' }, h('p', { class: 'label' }, label), h('p', { class: 'value' }, value), detail ? h('p', { class: 'detail' }, detail) : null);

  const chartBox = h('div', { class: 'chart' });
  const ALWAYS = new Set(['owner', 'account', 'local', 'visitor']);
  const whoRows = Object.keys(WHO_LONG).filter((w) => ALWAYS.has(w) || t.plays[w] || t.downloads[w] || t.visits[w] || t.seconds[w]).map((w) => h('tr', {},
    h('td', {}, WHO_LONG[w]),
    h('td', { class: 'num' }, count(t.plays[w])),
    h('td', { class: 'num' }, duration(t.seconds[w])),
    h('td', { class: 'num' }, count(t.downloads[w])),
    h('td', { class: 'num hide-narrow' }, bytes(t.downloadBytes[w])),
    h('td', { class: 'num' }, count(t.visits[w]))));

  const maxPlatform = Math.max(1, ...s.platforms.map((p) => p.plays));

  panel('overview').replaceChildren(
    h('div', { class: 'toolbar' }, ranges, h('span', { class: 'stamp' }, s.from ? `Since ${new Date(s.from).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Nothing logged yet')),
    h('div', { class: 'tiles' },
      tile('Plays', count(plays), `${count(playsSignedIn)} signed in · ${count(plays - playsSignedIn)} not`),
      tile('Play time', duration(sum(t.seconds)), `${duration(sum(t.seconds, (w) => SIGNED_IN.has(w)))} signed in · ${duration(sum(t.seconds, (w) => !SIGNED_IN.has(w)))} not`),
      tile('Downloads', count(downloads), `${count(downloadsSignedIn)} signed in · ${count(downloads - downloadsSignedIn)} not · ${bytes(sum(t.downloadBytes))}${t.downloadsUnfinished ? ` · ${count(t.downloadsUnfinished)} unfinished` : ''}`),
      tile('People', count(s.accountsActive + s.anonymousAddresses), `${plural(s.accountsActive, 'account')} · ${plural(s.anonymousAddresses, 'address', 'addresses')} not signed in`),
      tile('Games that failed', count(t.failures), t.failures ? 'See the list below' : 'None'),
      tile('Played with friends', count(t.hosted), `${plural(t.hosted, 'game')} hosted · ${plural(t.joined, 'friend')} joined`)),
    h('section', { class: 'card' },
      h('h2', {}, 'Plays by day'),
      h('div', { class: 'legend' },
        h('span', { style: '--swatch: var(--series-signed-in)' }, 'Signed in'),
        h('span', { style: '--swatch: var(--series-not-signed-in)' }, 'Not signed in')),
      chartBox,
      dayTable(s.byDay)),
    card('Who', 'Everything logged in this period, by who did it.', table(
      ['', { text: 'Plays', attrs: { class: 'num' } }, { text: 'Time', attrs: { class: 'num' } }, { text: 'Downloads', attrs: { class: 'num' } }, { text: 'Size', attrs: { class: 'num hide-narrow' } }, { text: 'Visits', attrs: { class: 'num' } }],
      whoRows, { empty: 'Nothing logged in this period.' })),
    h('div', { class: 'grid' },
      card('Most played', null, table(
        ['Game', { text: 'Plays', attrs: { class: 'num' } }, { text: 'Time', attrs: { class: 'num' } }, { text: 'People', attrs: { class: 'num' } }],
        s.topGames.map((g) => h('tr', {}, gameCell(g), h('td', { class: 'num' }, count(g.plays)), h('td', { class: 'num' }, duration(g.seconds)), h('td', { class: 'num' }, count(g.people)))),
        { empty: 'No games played in this period.' })),
      card('Platforms', null, table(
        ['Platform', '', { text: 'Plays', attrs: { class: 'num' } }, { text: 'Time', attrs: { class: 'num' } }],
        s.platforms.map((p) => h('tr', {},
          h('td', {}, p.platform),
          h('td', { class: 'bar-cell' }, h('div', { class: 'meter' }, h('i', { style: `width: ${(p.plays / maxPlatform) * 100}%` }))),
          h('td', { class: 'num' }, count(p.plays)),
          h('td', { class: 'num' }, duration(p.seconds)))),
        { empty: 'No games played in this period.' }))),
    h('div', { class: 'grid' },
      card('Most downloaded', null, table(
        ['Game', { text: 'Downloads', attrs: { class: 'num' } }, { text: 'People', attrs: { class: 'num' } }],
        s.topDownloads.map((g) => h('tr', {}, gameCell(g), h('td', { class: 'num' }, count(g.downloads)), h('td', { class: 'num' }, count(g.people)))),
        { empty: 'No games downloaded in this period.' })),
      card('Games that failed', 'Games that didn\'t start, or stopped while being played, most often first.', table(
        ['Game', { text: 'Times', attrs: { class: 'num' } }, 'Last'],
        s.failures.map((f) => h('tr', {},
          h('td', {}, h('span', {}, f.title), h('span', { class: 'line2' }, [f.platform, f.engine].filter(Boolean).join(' · ')), f.message ? h('span', { class: 'line2 clip', title: f.message }, f.message) : null),
          h('td', { class: 'num' }, count(f.count)),
          h('td', { class: 'nowrap' }, ago(f.last)))),
        { empty: 'No game failed in this period.' }))),
    h('div', { class: 'grid' },
      card('Signed-in people', null, table(
        ['Person', { text: 'Plays', attrs: { class: 'num' } }, { text: 'Time', attrs: { class: 'num' } }, { text: 'Downloads', attrs: { class: 'num' } }, 'Last'],
        s.people.map((p) => h('tr', {},
          h('td', {}, h('span', {}, p.name || p.email), p.name ? h('span', { class: 'line2' }, p.email) : null),
          h('td', { class: 'num' }, count(p.plays)), h('td', { class: 'num' }, duration(p.seconds)), h('td', { class: 'num' }, count(p.downloads)), h('td', { class: 'nowrap' }, ago(p.last)))),
        { empty: 'Nobody signed in did anything in this period.' })),
      card('Not signed in', 'By address, the most recent 50.', table(
        ['Address', { text: 'Plays', attrs: { class: 'num' } }, { text: 'Time', attrs: { class: 'num' } }, { text: 'Downloads', attrs: { class: 'num' } }, 'Last'],
        s.addresses.map((a) => h('tr', {},
          h('td', {}, h('span', { class: 'mono' }, a.ip), h('span', { class: 'line2' }, [a.country, a.who.map((w) => WHO_SHORT[w]).join(', ')].filter(Boolean).join(' · '))),
          h('td', { class: 'num' }, count(a.plays)), h('td', { class: 'num' }, duration(a.seconds)), h('td', { class: 'num' }, count(a.downloads)), h('td', { class: 'nowrap' }, ago(a.last)))),
        { empty: 'Nobody who wasn\'t signed in came by in this period.' }))),
  );
  drawChart(chartBox, s.byDay);
}

function gameCell(g) {
  return h('td', {}, h('span', {}, g.title), g.platform ? h('span', { class: 'line2' }, g.platform) : null);
}

/** The chart's numbers as a table, for reading exact values. */
function dayTable(days) {
  const rows = days.filter((d) => d.signedIn || d.notSignedIn || d.downloads || d.seconds).reverse().map((d) => h('tr', {},
    h('td', {}, shortDay(d.day)),
    h('td', { class: 'num' }, count(d.signedIn)),
    h('td', { class: 'num' }, count(d.notSignedIn)),
    h('td', { class: 'num' }, duration(d.seconds)),
    h('td', { class: 'num' }, count(d.downloads))));
  return h('details', { class: 'as-table' }, h('summary', {}, 'Show as a table'),
    table(['Day', { text: 'Signed in', attrs: { class: 'num' } }, { text: 'Not signed in', attrs: { class: 'num' } }, { text: 'Time', attrs: { class: 'num' } }, { text: 'Downloads', attrs: { class: 'num' } }], rows, { empty: 'Nothing on any day.' }));
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...children.flat(Infinity).filter(Boolean));
  return el;
}

/** A rectangle with its top corners rounded, standing on y + height. */
function topRounded(x, y, w, height, r) {
  const rr = Math.min(r, w / 2, height);
  return `M${x},${y + height}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + height}Z`;
}

/** Plays per day as stacked bars (signed in at the bottom), with a tooltip for each day. */
function drawChart(box, days) {
  const tip = h('div', { class: 'tooltip', hidden: true });
  const draw = () => {
    const width = box.clientWidth;
    if (!width) return;
    const height = 200;
    const pad = { l: 32, r: 4, t: 10, b: 24 };
    const plotW = width - pad.l - pad.r;
    const plotH = height - pad.t - pad.b;
    const top = Math.max(1, ...days.map((d) => d.signedIn + d.notSignedIn));
    const step = Math.max(1, Math.ceil(top / 4));
    const max = step * Math.ceil(top / step);
    const y = (v) => pad.t + plotH - (v / max) * plotH;
    const band = plotW / Math.max(1, days.length);
    const barW = Math.max(1, Math.min(28, band * 0.72));
    const gap = band > 6 ? 2 : 0;

    const grid = [];
    for (let v = 0; v <= max; v += step) {
      grid.push(svg('line', { class: 'grid-line', x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v) }));
      grid.push(svg('text', { class: 'axis-label', x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
    }
    // Day labels far enough apart not to run into each other.
    const every = Math.max(1, Math.ceil(56 / band));
    const labels = days.map((d, i) => ((days.length - 1 - i) % every === 0
      ? svg('text', { class: 'axis-label', x: pad.l + band * i + band / 2, y: height - 6, 'text-anchor': 'middle' }, shortDay(d.day)) : null));

    const bars = days.map((d, i) => {
      const x = pad.l + band * i + (band - barW) / 2;
      const parts = [];
      const signedH = (d.signedIn / max) * plotH;
      const notH = (d.notSignedIn / max) * plotH;
      if (d.signedIn) parts.push(svg('path', { d: topRounded(x, y(d.signedIn), barW, signedH, d.notSignedIn ? 0 : 4), style: 'fill: var(--series-signed-in)' }));
      if (d.notSignedIn) {
        // A thin gap of the card's colour between the two parts, taken out of the upper one.
        const lift = d.signedIn && notH > gap + 1 ? gap : 0;
        parts.push(svg('path', { d: topRounded(x, y(d.signedIn + d.notSignedIn), barW, notH - lift, 4), style: 'fill: var(--series-not-signed-in)' }));
      }
      return parts;
    });

    const hits = days.map((d, i) => svg('rect', {
      class: 'hit', x: pad.l + band * i, y: pad.t, width: band, height: plotH,
    }));
    hits.forEach((hit, i) => {
      const d = days[i];
      const showTip = () => {
        tip.replaceChildren(h('b', {}, new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })),
          h('div', {}, h('i', { style: 'background: var(--series-signed-in)' }), `Signed in: ${count(d.signedIn)}`),
          h('div', {}, h('i', { style: 'background: var(--series-not-signed-in)' }), `Not signed in: ${count(d.notSignedIn)}`),
          h('div', { class: 'muted' }, `Played for ${duration(d.seconds)}`),
          h('div', { class: 'muted' }, `Downloads: ${count(d.downloads)}`));
        tip.hidden = false;
        const center = pad.l + band * i + band / 2;
        const tipW = tip.offsetWidth;
        tip.style.left = `${Math.min(Math.max(0, center - tipW / 2), width - tipW)}px`;
        tip.style.top = `${Math.max(0, y(d.signedIn + d.notSignedIn) - tip.offsetHeight - 8)}px`;
      };
      hit.addEventListener('mouseenter', showTip);
      hit.addEventListener('mouseleave', () => { tip.hidden = true; });
      hit.addEventListener('touchstart', showTip, { passive: true });
    });

    box.replaceChildren(svg('svg', { width, height, role: 'img', 'aria-label': 'Plays by day, signed in and not signed in' }, grid, labels, bars, hits), tip);
  };
  draw();
  page.chartObserver?.disconnect();
  page.chartObserver = new ResizeObserver(() => { if (box.clientWidth !== Number(box.querySelector('svg')?.getAttribute('width'))) draw(); });
  page.chartObserver.observe(box);
}

// ---------- Right now ----------

function scheduleLive() {
  clearTimeout(page.liveTimer);
  if (page.tab === 'live' && !document.hidden) page.liveTimer = setTimeout(() => loadLive({ timed: true }), LIVE_EVERY_MS);
}

async function loadLive({ timed = false } = {}) {
  const el = panel('live');
  const my = ++page.seq.live;
  if (!el.childElementCount) el.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    const [live, latest] = await Promise.all([api('/admin/live'), api('/admin/activity?type=play&limit=10')]);
    // A timed refresh gives way while a button is held, text is selected or a change is still
    // on its way: redrawing then would drop the click, the selection or the disabled button.
    // The next one catches up.
    if (my === page.seq.live && page.tab === 'live' && !(timed && interacting(el))) renderLive(live, latest.events);
  } catch (err) {
    if (my === page.seq.live) errorIn(el, err);
  }
  if (my === page.seq.live) scheduleLive();
}

const HOUR = 60 * 60 * 1000;

function renderLive(live, plays) {
  rebuild(panel('live'),
    card('Playing now', 'Games open in someone\'s browser right now. Time counts only while the game is on screen.', table(
      ['Game', 'Who', { text: 'Time', attrs: { class: 'num' } }, 'From', { text: 'Browser', attrs: { class: 'hide-narrow' } }],
      live.playing.map((p) => h('tr', {},
        gameCell(p),
        whoCell(p),
        h('td', { class: 'num' }, p.seconds ? duration(p.seconds) : 'just started', h('span', { class: 'line2' }, p.onScreen ? ['since ', ago(p.startedAt)] : h('span', { class: 'tag' }, 'in the background'))),
        fromCell(p),
        h('td', { class: 'hide-narrow' }, browserOf(p.agent)))),
      { empty: 'Nobody is playing right now.' })),
    h('div', { class: 'grid' },
      card('Games with friends', 'Games hosted for friends to join, open right now.', table(
        ['Game', 'Players', 'Since', ''],
        live.rooms.map((r) => h('tr', {},
          h('td', {}, h('span', {}, r.title), h('span', { class: 'line2' }, [r.platform, `hosted by ${r.hostName}`, r.open ? null : 'starting'].filter(Boolean).join(' · '))),
          h('td', {}, `${r.players} of ${r.max}`, r.names.length ? h('span', { class: 'line2' }, r.names.join(', ')) : null),
          h('td', { class: 'nowrap' }, ago(r.created)),
          h('td', { class: 'num' }, h('button', { type: 'button', class: 'button is-small is-danger', dataset: { key: `end-${r.code}` }, onclick: (e) => endRoom(e.currentTarget, r) }, 'End')))),
        { empty: 'No games hosted right now.' })),
      card('Downloads', live.downloadsWaiting ? `${plural(live.downloadsWaiting, 'download')} waiting for a turn to be packed.` : 'Being sent right now.', table(
        ['Game', 'Who', { text: 'Sent', attrs: { class: 'num' } }],
        live.downloads.map((d) => h('tr', {},
          h('td', {}, h('span', {}, d.title), h('span', { class: 'line2' }, [d.platform, d.kind === 'offline' ? 'to play offline' : 'game files'].filter(Boolean).join(' · '))),
          h('td', {}, d.who ?? h('span', { class: 'mono' }, d.ip ?? '?'), h('span', { class: 'line2' }, ago(d.started))),
          h('td', { class: 'num' }, bytes(d.bytes)))),
        { empty: 'No downloads right now.' }))),
    card('Latest plays', 'The last games started, by anyone.', table(
      ['Game', 'Who', 'When'],
      plays.map((e) => h('tr', {}, gameCell(e), whoCell(e), h('td', { class: 'nowrap' }, ago(e.t)))),
      { empty: 'No games played yet.' })),
    ...(!live.preparing.length ? [] : [card('Being made ready', 'Games the server is unpacking or copying before they can be played or downloaded.',
      h('ul', {}, live.preparing.map((p) => h('li', {}, p.title, p.platform ? h('span', { class: 'muted' }, ` · ${p.platform}`) : null))))]),
    h('p', { class: 'stamp' }, `Updated ${new Date().toLocaleTimeString()}, every few seconds while this tab is open.`),
  );
}

/** Letting guests in for a demo: anyone not signed in may play and download while it's on. */
function guestsCard(g) {
  const letIn = (label, ms) => h('button', {
    type: 'button',
    class: 'button',
    dataset: { key: `guests-${ms}` },
    onclick: (e) => setGuests(e.currentTarget, true, ms),
  }, label);
  return card('Guests', null,
    h('p', {}, g.guestsCanPlay
      ? [h('span', { class: 'tag is-on' }, 'Guests can play'), ' ', ...(g.guestsUntil ? ['until ', h('b', {}, new Date(g.guestsUntil).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }))] : ['until you turn it off'])]
      : [h('span', { class: 'tag' }, 'Off'), ' Guests can only browse.']),
    h('p', { class: 'sub' }, 'For a demo: anyone who opens the site without signing in, on this network or from the internet, can play and download every game, and keep favorites in their own browser. Signed-in accounts that can only browse can play too while it\'s on. Their plays show on this page but aren\'t counted as their own.'),
    h('div', { class: 'buttons' },
      g.guestsCanPlay ? h('span', { class: 'muted' }, 'Change to:') : h('span', { class: 'muted' }, 'Let guests in:'),
      letIn('1 hour', HOUR), letIn('3 hours', 3 * HOUR), letIn('1 day', 24 * HOUR), letIn('Until I turn it off', 0),
      g.guestsCanPlay ? h('button', { type: 'button', class: 'button is-danger', dataset: { key: 'guests-off' }, onclick: (e) => setGuests(e.currentTarget, false) }, 'Turn off now') : null));
}

/** Guests let in for `ms` (0 or none: until turned off), or turned off. */
async function setGuests(button, on, ms = 0) {
  // How long, for the server to count from its own clock; with no time, guestsUntil null clears one.
  const body = on && ms ? { guestsCanPlay: on, guestsForMinutes: ms / 60_000 } : { guestsCanPlay: on, guestsUntil: null };
  await act(button, () => api('/server-settings', { method: 'PUT', body }),
    (s) => (s.guestsCanPlay ? `Guests can play${s.guestsUntil ? ` until ${new Date(s.guestsUntil).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ' until you turn it off'}.` : 'Guests can only browse now.'));
  loadAccounts();
}

async function endRoom(button, room) {
  if (!confirm(`End ${room.title}? Everyone in it is disconnected.`)) return;
  await act(button, () => api(`/admin/rooms/${encodeURIComponent(room.code)}/end`, { method: 'POST' }), 'The game was ended.');
  loadLive();
}

// ---------- Accounts ----------

async function loadAccounts() {
  const el = panel('accounts');
  if (!el.childElementCount) el.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    const data = await api('/admin/accounts');
    if (page.tab === 'accounts') renderAccounts(data);
  } catch (err) {
    errorIn(el, err);
  }
}

function avatar(a) {
  const letter = (a.name || a.email).trim()[0]?.toUpperCase() ?? '?';
  if (!a.picture) return h('span', { class: 'avatar', 'aria-hidden': 'true' }, letter);
  const img = h('img', { class: 'avatar', src: a.picture, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'avatar', 'aria-hidden': 'true' }, letter)));
  return img;
}

/** How an account is named under its name: a local account by its username, a Google one by its address. */
const accountLine = (a) => (a.local ? `${a.username} · local account` : a.email);
const accountName = (a) => a.name || a.username || a.email;

function renderAccounts(data) {
  const el = panel('accounts');
  if (!data.enabled) {
    rebuild(el,
      signInCard(data),
      guestsCard(data.guests),
      card('No accounts', null,
        h('p', {}, 'Neither Google sign-in nor local accounts are on, so there are no accounts: everyone on the local network can play, download and share one set of favorites, this admin page opens only on this PC (at localhost), and the internet can only browse unless guests are let in (above).')));
    return;
  }
  const email = h('input', { type: 'email', required: true, placeholder: 'someone@gmail.com', 'aria-label': 'Email address', autocomplete: 'off' });
  const access = h('select', { 'aria-label': 'Access' }, Object.entries(ACCESS_LABELS).map(([value, label]) => h('option', { value }, label)));
  const add = h('form', {
    class: 'add-account',
    onsubmit: async (e) => {
      e.preventDefault();
      const address = email.value.trim();
      if (!address) return;
      const ok = await act(e.submitter, () => api(`/admin/accounts/${encodeURIComponent(address)}`, { method: 'PUT', body: { access: access.value } }), `${address}: ${ACCESS_LABELS[access.value].toLowerCase()}.`);
      if (ok) loadAccounts();
    },
  }, email, access, h('button', { type: 'submit', class: 'button is-primary' }, 'Add'));

  const rows = data.accounts.map((a) => h('tr', {},
    h('td', {}, h('div', { class: 'person' }, avatar(a), h('div', { class: 'who' }, h('b', {}, accountName(a)), a.name || a.local ? h('span', {}, accountLine(a)) : null))),
    h('td', {}, a.access === 'owner' ? h('span', { class: 'tag is-on' }, 'Owner')
      : [h('select', {
        'aria-label': `Access for ${a.email}`,
        dataset: { key: `access-${a.email}` },
        onchange: (e) => changeAccess(e.currentTarget, a),
      }, Object.entries(ACCESS_LABELS).map(([value, label]) => h('option', { value, selected: value === a.access }, label))),
      a.fromConfig && a.access === 'play' ? h('span', { class: 'line2' }, 'from players in the config') : null,
      a.isNew ? h('span', { class: 'line2' }, h('span', { class: 'tag is-on' }, 'New')) : null]),
    h('td', { class: 'nowrap' }, ago(a.lastSeen), a.firstSeen ? h('span', { class: 'line2' }, ['first ', ago(a.firstSeen)]) : null),
    h('td', { class: 'num' }, count(a.plays)),
    h('td', { class: 'num' }, duration(a.seconds)),
    h('td', { class: 'num' }, count(a.downloads)),
    h('td', { class: 'num' }, count(a.sessions)),
    h('td', { class: 'num' }, h('div', { class: 'buttons row-actions' },
      a.sessions ? h('button', { type: 'button', class: 'button is-small', dataset: { key: `signout-${a.email}` }, onclick: (e) => signOut(e.currentTarget, a) }, 'Sign out everywhere') : null,
      // Not your own: that's changed from the profile menu, which asks for the current password.
      a.local && a.access !== 'owner' ? h('button', { type: 'button', class: 'button is-small', dataset: { key: `reset-${a.email}` }, onclick: (e) => resetPassword(e.currentTarget, a) }, 'Reset password') : null,
      a.local && a.access !== 'owner' ? h('button', { type: 'button', class: 'button is-small is-danger', dataset: { key: `delete-${a.email}` }, onclick: (e) => deleteLocal(e.currentTarget, a) }, 'Delete') : null))));

  const fresh = data.accounts.filter((a) => a.isNew);
  rebuild(el,
    ...(!fresh.length ? [] : [card('New sign-ins', 'People who signed in that you haven\'t decided about yet. Until you do they can only browse, and nothing on the site tells them they could do more or ask for it.', table(
      ['Account', 'Signed in', 'Last from', ''],
      fresh.map((a) => h('tr', {},
        h('td', {}, h('div', { class: 'person' }, avatar(a), h('div', { class: 'who' }, h('b', {}, accountName(a)), a.name || a.local ? h('span', {}, accountLine(a)) : null))),
        h('td', { class: 'nowrap' }, ago(a.firstSeen), h('span', { class: 'line2' }, ['last seen ', ago(a.lastSeen), ` · ${plural(a.visits, 'visit')}`])),
        fromCell(a),
        h('td', { class: 'num decide-cell' }, h('div', { class: 'buttons decide' },
          h('button', { type: 'button', class: 'button is-small is-primary', onclick: (e) => decide(e.currentTarget, a, 'play') }, 'Let them play'),
          h('button', { type: 'button', class: 'button is-small', onclick: (e) => decide(e.currentTarget, a, 'browse') }, 'Keep browsing'),
          h('button', { type: 'button', class: 'button is-small is-danger', onclick: (e) => decide(e.currentTarget, a, 'blocked') }, 'Block')))))))]),
    signInCard(data),
    guestsCard(data.guests),
    card('Who may do what', null,
      h('dl', { class: 'facts' },
        h('dt', {}, ACCESS_LABELS.play), h('dd', {}, 'Plays and downloads games, with their plays counted, and keeps their own favorites.'),
        h('dt', {}, ACCESS_LABELS.browse), h('dd', {}, 'Keeps their own favorites. Everyone who signs in starts here, and shows under New sign-ins until you decide.'),
        h('dt', {}, ACCESS_LABELS.blocked), h('dd', {}, 'Can\'t sign in; changing to this signs them out everywhere. They can still browse like anyone not signed in.'),
        h('dt', {}, 'Not signed in'), h('dd', {}, data.localNetworkCanPlay
          ? 'Browses. On the local network they can also play and download (localNetworkCanPlay in the config), and so can guests while you let them in.'
          : 'Browses, and plays while you let guests in.'))),
    data.local.enabled ? addLocalCard() : null,
    data.google ? card('Add a Google account', 'Give someone access before they first sign in with Google.', add) : null,
    card('Accounts', `${plural(data.accounts.length, 'account')}, most recently seen first. Plays and downloads are everything in the activity log.`, table(
      ['Account', 'Access', 'Last seen', { text: 'Plays', attrs: { class: 'num' } }, { text: 'Time', attrs: { class: 'num' } }, { text: 'Downloads', attrs: { class: 'num' } }, { text: 'Sessions', attrs: { class: 'num' } }, ''],
      rows, { empty: 'Nobody has signed in yet.' })),
  );
  // The new sign-ins' card, first when there is one, stacks on a phone (see admin.css).
  if (fresh.length) el.firstElementChild.classList.add('queue');
}

/** A new sign-in decided about: let play, kept browsing (no longer new), or blocked. */
async function decide(button, a, access) {
  if (access === 'blocked' && !confirm(`Block ${a.email}? They're signed out everywhere and can't sign in again until you change this.`)) return;
  const ok = await act(button, () => api(`/admin/accounts/${encodeURIComponent(a.email)}`, { method: 'PUT', body: { access } }),
    `${a.name || a.email}: ${ACCESS_LABELS[access].toLowerCase()}.`);
  if (ok) {
    loadAccounts();
    loadBadges();
  }
}

async function changeAccess(select, a) {
  const access = select.value;
  if (access === 'blocked' && !confirm(`Block ${a.email}? They're signed out everywhere and can't sign in again until you change this.`)) {
    select.value = a.access;
    return;
  }
  const result = await act(select, () => api(`/admin/accounts/${encodeURIComponent(a.email)}`, { method: 'PUT', body: { access } }),
    (r) => `${a.email}: ${ACCESS_LABELS[r.account.access].toLowerCase()}${r.ended ? `, signed out of ${plural(r.ended, 'session')}` : ''}.`);
  if (!result) select.value = a.access;
  loadAccounts();
  loadBadges();
}

// ---------- Signing in: Google, and local accounts (see server/lib/localusers.js) ----------

/**
 * The ways to sign in: Google's, which is set up in the config, and local accounts, which the
 * owner turns on here. On a server without Google, turning local accounts on makes the owner's
 * account first (with no accounts, the owner is whoever is at this PC) and signs this
 * browser in with it.
 */
function signInCard(data) {
  const local = data.local;
  const ownerForm = h('form', { class: 'owner-form', hidden: true },
    h('p', {}, h('b', {}, 'Your owner account. '), 'Without Google sign-in, the owner is whoever signs in as this account: once local accounts are on, being on the local network no longer makes someone the owner. This browser is signed in with it straight away.'),
    h('div', { class: 'add-account' },
      h('input', { type: 'text', name: 'username', required: true, placeholder: 'Username', 'aria-label': 'Username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 32 }),
      h('input', { type: 'text', name: 'name', placeholder: 'Name (optional)', 'aria-label': 'Name', autocomplete: 'name', maxlength: 100 }),
      h('input', { name: 'password', type: 'password', required: true, minlength: 8, placeholder: 'Password (8 or more characters)', 'aria-label': 'Password', autocomplete: 'new-password' }),
      h('input', { name: 'again', type: 'password', required: true, minlength: 8, placeholder: 'Password again', 'aria-label': 'Password again', autocomplete: 'new-password' }),
      h('button', { type: 'submit', class: 'button is-primary' }, 'Turn on local accounts')));
  ownerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(ownerForm));
    if (f.password !== f.again) return notify('The two passwords aren\'t the same.', 'error', 6000);
    const r = await act(e.submitter, () => api('/admin/local-logins', { method: 'POST', body: { enabled: true, owner: { username: f.username, name: f.name, password: f.password } } }), 'Local accounts are on, and you\'re signed in as the owner.');
    if (r) location.reload();
  });

  const onOff = h('input', {
    type: 'checkbox',
    checked: local.enabled,
    dataset: { key: 'local-logins' },
    onchange: async (e) => {
      const box = e.currentTarget;
      if (box.checked && local.needsOwner) {
        box.checked = false;
        ownerForm.hidden = false;
        ownerForm.querySelector('input').focus();
        return;
      }
      if (!box.checked && !confirm(data.google
        ? 'Turn local accounts off? Everyone signed in with one is signed out, and none can sign in until they\'re on again.'
        : 'Turn local accounts off? There are no accounts at all then: everyone on the local network can play, this admin page opens only on this PC, and everyone signed in with a local account is signed out.')) {
        box.checked = true;
        return;
      }
      const r = await act(box, () => api('/admin/local-logins', { method: 'POST', body: { enabled: box.checked } }), box.checked ? 'Local accounts are on.' : 'Local accounts are off.');
      if (!r) box.checked = !box.checked;
      // Who the owner is may have changed with it (see above).
      else if (r.signedIn || (!box.checked && !data.google)) location.reload();
      else loadAccounts();
    },
  });
  const signup = h('input', {
    type: 'checkbox',
    checked: local.signup,
    dataset: { key: 'local-signup' },
    onchange: async (e) => {
      const box = e.currentTarget;
      const r = await act(box, () => api('/admin/local-logins', { method: 'POST', body: { signup: box.checked } }), box.checked ? 'Anyone can make an account now.' : 'Only you can make accounts now.');
      if (!r) box.checked = !box.checked;
    },
  });
  return card('Signing in', null,
    h('div', { class: 'checks' },
      h('div', { class: 'check is-static' },
        h('span', { class: `tag${data.google ? ' is-on' : ''}` }, data.google ? 'On' : 'Off'),
        h('span', {}, h('b', {}, 'Google'), h('span', { class: 'line2' }, data.google
          ? 'Set up in config.local.json. Anyone with a Google account can sign in, and starts out able to browse only.'
          : 'Not set up: it needs a Google client ID in config.local.json (see "Signing in with Google" in docs/guide.md).'))),
      h('label', { class: 'check' }, onOff,
        h('span', {}, h('b', {}, 'Local accounts'), h('span', { class: 'line2' }, 'A username and password kept on this server, for people without Google or for a server without it. You make the accounts below and hand out the passwords; each person can change theirs from their profile menu.'))),
      local.enabled ? h('label', { class: 'check' }, signup,
        h('span', {}, h('b', {}, 'Anyone can make their own local account'), h('span', { class: 'line2' }, 'From the profile menu\'s sign-in. A new account can only browse, and shows under New sign-ins until you decide, like a first Google sign-in.'))) : null),
    ownerForm);
}

/** The owner makes a local account and hands its username and password on. */
function addLocalCard() {
  const form = h('form', { class: 'add-account' },
    h('input', { type: 'text', name: 'username', required: true, placeholder: 'Username', 'aria-label': 'Username', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 32 }),
    h('input', { type: 'text', name: 'name', placeholder: 'Name (optional)', 'aria-label': 'Name', autocomplete: 'off', maxlength: 100 }),
    h('input', { name: 'password', type: 'text', required: true, minlength: 8, placeholder: 'Password (8 or more)', 'aria-label': 'Password', autocomplete: 'off', spellcheck: 'false' }),
    h('select', { name: 'access', 'aria-label': 'Access' }, ['browse', 'play'].map((value) => h('option', { value, selected: value === 'play' }, ACCESS_LABELS[value]))),
    h('button', { type: 'submit', class: 'button is-primary' }, 'Add'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const r = await act(e.submitter, () => api('/admin/local-users', { method: 'POST', body: f }), `${f.username.trim().toLowerCase()} can sign in now.`);
    if (r) loadAccounts();
  });
  return card('Add a local account', 'Give them the username and password; they can change the password from their profile menu. The password shows as you type it, since it\'s one to hand on.', form);
}

async function resetPassword(button, a) {
  const password = prompt(`A new password for ${a.username} (8 or more characters). They're signed out everywhere and sign in with this one.`);
  if (password == null) return;
  await act(button, () => api(`/admin/local-users/${encodeURIComponent(a.username)}/password`, { method: 'POST', body: { password } }), `${a.username}'s password is changed.`);
  loadAccounts();
}

async function deleteLocal(button, a) {
  if (!confirm(`Delete the local account ${a.username}? They're signed out everywhere, and their favorites and plays here are deleted too. Their plays stay in the activity log.`)) return;
  await act(button, () => api(`/admin/local-users/${encodeURIComponent(a.username)}`, { method: 'DELETE' }), `${a.username} was deleted.`);
  loadAccounts();
  loadBadges();
}

async function signOut(button, a) {
  if (!confirm(`Sign ${a.email} out on every device?`)) return;
  await act(button, () => api(`/admin/accounts/${encodeURIComponent(a.email)}/signout`, { method: 'POST' }), (r) => `Ended ${plural(r.ended, 'session')}.`);
  loadAccounts();
}

// ---------- Activity ----------

function whoCell(e) {
  const signedIn = SIGNED_IN.has(e.who);
  return h('td', {},
    h('span', {}, signedIn ? (e.name || e.email || WHO_SHORT[e.who]) : (e.who === 'friend' && e.name ? e.name : WHO_SHORT[e.who])),
    h('span', { class: 'line2' }, signedIn ? (e.name ? e.email : WHO_SHORT[e.who]) : e.who === 'friend' ? 'Friend' : 'Not signed in'));
}

/** An address, with its country and whether it came through the internet. */
function fromCell(e) {
  if (!e.ip) return h('td', { class: 'muted' }, '?');
  return h('td', { class: 'nowrap' }, h('span', { class: 'mono' }, e.ip), h('span', { class: 'line2' }, [e.country, e.via === 'internet' ? 'internet' : 'local network'].filter(Boolean).join(' · ')));
}

function whatOf(e) {
  const game = e.title ?? 'a game';
  const bits = (...parts) => parts.filter(Boolean).join(' · ');
  switch (e.type) {
    case 'visit': return ['Opened the site', ''];
    case 'play': return [`Played ${game}`, bits(e.platform, e.engine)];
    case 'stop': return [`Played ${game} for ${duration(e.seconds)}`, bits(e.platform, e.how === 'lost' && 'the page stopped checking in')];
    case 'download': return [`Downloaded ${game}`, bits(e.kind === 'offline' ? 'to play offline' : 'game files', e.bytes != null && bytes(e.bytes), e.complete === false && 'didn\'t finish')];
    case 'failed': return [`${game} failed`, bits(e.platform, e.message)];
    case 'signin': return ['Signed in', ''];
    case 'badsignin': return [`Failed to sign in as ${e.name ?? '?'}`, e.message ?? ''];
    case 'host': return [`Hosted ${game} for friends`, e.platform ?? ''];
    case 'join': return [`Joined ${game}`, e.platform ?? ''];
    default: return [e.type, ''];
  }
}

function activityQuery(before = '') {
  const a = page.activity;
  const params = new URLSearchParams({ limit: '100' });
  if (a.type) params.set('type', a.type);
  if (a.who) params.set('who', a.who);
  if (a.q) params.set('q', a.q);
  if (before) params.set('before', before);
  return `/admin/activity?${params}`;
}

async function loadActivity({ more = false } = {}) {
  const el = panel('activity');
  if (!el.childElementCount) buildActivity();
  const a = page.activity;
  // Only the latest request counts: a new filter or search drops a slower one before it,
  // including a "Show older" still out, whose rows belong to the old filter. "Show older" waits
  // meanwhile, so it neither pages from a list about to be replaced nor asks twice.
  const my = ++a.seq;
  const moreButton = $('#activity-more');
  moreButton.disabled = true;
  const before = more ? a.events.at(-1)?.t ?? '' : '';
  try {
    const { events } = await api(activityQuery(before));
    if (my !== a.seq) return;
    a.events = more ? [...a.events, ...events] : events;
    a.more = events.length === 100;
    if (page.tab === 'activity') renderActivityRows();
  } catch (err) {
    if (my !== a.seq) return;
    if (more) {
      notify(`Couldn't load the activity: ${err.message}`, 'error', 8000);
      return;
    }
    a.events = [];
    a.more = false;
    $('#activity-rows').replaceChildren(h('p', { class: 'bad' }, `Couldn't load the activity: ${err.message}`),
      h('button', { class: 'button', type: 'button', onclick: () => loadActivity() }, 'Try again'));
    moreButton.hidden = true;
    $('#activity-count').textContent = '';
  } finally {
    if (my === a.seq) moreButton.disabled = false;
  }
}

function buildActivity() {
  const a = page.activity;
  const type = h('select', { 'aria-label': 'What', onchange: (e) => { a.type = e.currentTarget.value; loadActivity(); } },
    h('option', { value: '' }, 'Everything'), Object.entries(TYPE_LABELS).map(([value, label]) => h('option', { value }, label)));
  const who = h('select', { 'aria-label': 'Who', onchange: (e) => { a.who = e.currentTarget.value; loadActivity(); } },
    h('option', { value: '' }, 'Everyone'),
    h('option', { value: 'signed-in' }, 'Signed in'),
    h('option', { value: 'not-signed-in' }, 'Not signed in'),
    Object.entries(WHO_LONG).map(([value, label]) => h('option', { value }, label)));
  let timer = 0;
  const search = h('input', {
    type: 'search', class: 'grow', placeholder: 'Search names, addresses, games…', 'aria-label': 'Search',
    oninput: (e) => {
      clearTimeout(timer);
      const value = e.currentTarget.value.trim();
      timer = setTimeout(() => { a.q = value; loadActivity(); }, 300);
    },
  });
  panel('activity').replaceChildren(
    h('div', { class: 'toolbar' }, type, who, search),
    h('section', { class: 'card' }, h('div', { id: 'activity-rows' }, h('p', { class: 'muted' }, 'Loading…')),
      h('div', { class: 'buttons', style: 'margin-top: 12px' },
        h('button', { type: 'button', class: 'button', id: 'activity-more', hidden: true, onclick: () => loadActivity({ more: true }) }, 'Show older'),
        h('span', { class: 'stamp', id: 'activity-count' }))),
  );
}

function renderActivityRows() {
  const a = page.activity;
  const rows = a.events.map((e) => {
    const [what, detail] = whatOf(e);
    return h('tr', {},
      h('td', { class: 'nowrap' }, ago(e.t)),
      h('td', {}, h('span', {}, what), detail ? h('span', { class: 'line2 clip', title: detail }, detail) : null),
      whoCell(e),
      fromCell(e),
      h('td', { class: 'hide-narrow' }, browserOf(e.agent)));
  });
  $('#activity-rows').replaceChildren(table(['When', 'What', 'Who', 'From', { text: 'Browser', attrs: { class: 'hide-narrow' } }], rows, { empty: 'Nothing matches.' }));
  $('#activity-more').hidden = !a.more;
  $('#activity-count').textContent = a.events.length ? `Showing ${plural(a.events.length, 'event')}, newest first.` : '';
}

// ---------- Server ----------

async function loadServer() {
  const el = panel('server');
  if (!el.childElementCount) el.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    const data = await api('/admin/system');
    if (page.tab === 'server') renderServer(data);
  } catch (err) {
    errorIn(el, err);
  }
}

function uptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const hrs = Math.floor((seconds % 86400) / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  return d ? `${d} d ${hrs} h` : hrs ? `${hrs} h ${min} min` : `${min} min`;
}

function renderServer(s) {
  const fact = (label, ...value) => [h('dt', {}, label), h('dd', {}, ...value)];
  const months = s.logs.activity.months;
  panel('server').replaceChildren(
    shelfDefaultsCard(s.shelfDefaults ?? {}),
    h('div', { class: 'grid' },
      card('This server', null, h('dl', { class: 'facts' },
        fact('Version', s.build.version ?? '?'),
        fact('Build', h('span', { class: 'mono' }, s.build.build), s.build.dirty ? h('span', { class: 'muted' }, ' (changes not committed)') : null),
        fact('Started', ago(s.build.startedAt), h('span', { class: 'muted' }, ` · up ${uptime(s.uptimeSeconds)}`)),
        fact('Node', s.node),
        fact('Memory', bytes(s.memoryBytes)))),
      card('Library', null, h('dl', { class: 'facts' },
        fact('Platforms', count(s.library.platforms)),
        fact('Games', count(s.library.games)),
        fact('Versions', count(s.library.versions)),
        fact('Not working in the browser', `${count(s.library.notWorking)} versions`))),
      card('From the config', ['Set in ', h('span', { class: 'mono' }, s.configFile ?? 'config.local.json'), '; a change needs a restart.'], h('dl', { class: 'facts' },
        fact('Google sign-in', s.settings.accounts ? 'set up' : 'not set up'),
        fact('Local accounts', s.settings.localAccounts ? 'on' : 'off', h('span', { class: 'muted' }, ' (Accounts tab)')),
        fact('Local network plays', s.settings.localNetworkCanPlay ? 'without signing in' : 'only signed-in players'),
        fact('Allowed host names', s.settings.allowedHosts.length ? s.settings.allowedHosts.join(', ') : h('span', { class: 'muted' }, 'none')),
        fact('Activity log kept', plural(s.settings.activityKeepMonths, 'month')))),
      publicUrlCard(s),
      launchboxCard(s)),
    h('div', { class: 'grid' },
      card('Disks', null, table(['', { text: 'Free', attrs: { class: 'num' } }, ''],
        s.disks.map((d) => h('tr', {},
          h('td', {}, h('span', {}, d.label), h('span', { class: 'line2 mono clip', title: d.path }, d.path)),
          h('td', { class: 'num' }, d.freeBytes == null ? '?' : bytes(d.freeBytes), d.totalBytes ? h('span', { class: 'line2' }, `of ${bytes(d.totalBytes)}`) : null),
          h('td', { class: 'bar-cell' }, d.totalBytes ? h('div', { class: 'meter', title: `${Math.round((1 - d.freeBytes / d.totalBytes) * 100)}% used` }, h('i', { style: `width: ${(1 - d.freeBytes / d.totalBytes) * 100}%` })) : null))))),
      cachesCard(s.caches),
      card('Logs', null, h('dl', { class: 'facts' },
        fact('Activity', `${bytes(s.logs.activity.bytes)}`, months.length ? h('span', { class: 'muted' }, ` · ${months[0]} to ${months.at(-1)}`) : null,
          h('span', { class: 'line2 mono' }, 'userdata/activity/')),
        fact('Games with friends', `${bytes(s.logs.netplay.bytes)} · ${plural(s.logs.netplay.files, 'session')}`,
          h('span', { class: 'line2' }, h('a', { href: '/netplay-stats.html' }, 'Multiplayer stats page'))),
        fact('Server', `${bytes(s.logs.server.bytes)} · ${plural(s.logs.server.days, 'day')}`,
          h('span', { class: 'line2 mono clip', title: s.logs.server.dir }, s.logs.server.dir))))),
    serverLogCard(),
  );
  loadLog();
}

/**
 * The server's own log: what it would have written to its console window, which an installed
 * copy (a Windows service) has none of. The latest lines, all of them or only the problems.
 */
function serverLogCard() {
  const choose = (errors) => {
    page.logErrors = errors;
    for (const b of document.querySelectorAll('#log-which button')) b.setAttribute('aria-pressed', String((b.dataset.errors === '1') === errors));
    loadLog();
  };
  return card('Server log', 'What the server has written, newest at the bottom: startup, library loads, warnings and errors. A file a day, kept 30 days.',
    h('div', { class: 'toolbar' },
      h('div', { class: 'segmented', id: 'log-which' },
        h('button', { type: 'button', 'aria-pressed': String(!page.logErrors), dataset: { errors: '0' }, onclick: () => choose(false) }, 'Everything'),
        h('button', { type: 'button', 'aria-pressed': String(page.logErrors), dataset: { errors: '1' }, onclick: () => choose(true) }, 'Warnings and errors')),
      h('button', { type: 'button', class: 'button is-small', onclick: () => loadLog() }, 'Refresh'),
      h('span', { class: 'stamp', id: 'log-stamp' })),
    h('pre', { class: 'log-lines', id: 'log-lines', tabindex: '0' }, 'Loading…'));
}

async function loadLog() {
  const box = $('#log-lines');
  if (!box) return;
  try {
    const r = await api(`/admin/log?lines=500${page.logErrors ? '&errors=1' : ''}`);
    box.textContent = r.lines.length ? r.lines.join('\n') : (r.started ? 'Nothing logged yet.' : 'This server isn\'t keeping a log (it was started without server/start.js).');
    box.scrollTop = box.scrollHeight;
    $('#log-stamp').textContent = `${plural(r.lines.length, 'line')} · ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    box.textContent = `Couldn't read the log: ${err.message}`;
  }
}

// What the shelf shows everyone (see SHELF_FLAGS in server/lib/settings.js), in the order the
// card lists them. `personal`: each person can change it for themselves, in their profile menu.
const SHELF_DEFAULTS = [
  { flag: 'showNonEnglish', label: 'Show games without an English release', help: 'Japanese and other region-only console releases, with no USA, European, World or fan-translated version.', personal: true },
  { flag: 'showBroken', label: 'Show games that don\'t work in the browser', help: 'A crash in the browser build, too much data to load, or a file or helper program the browser can\'t use. Only people who can play ever see these.', personal: true },
  { flag: 'showPrereleases', label: 'Show betas, demos, and prototypes', help: 'Unfinished releases that never shipped.' },
  { flag: 'showNoImage', label: 'Show games without a picture', help: 'Games LaunchBox has no box art or screenshot for, which show up as blank tiles.' },
  { flag: 'pcMultiplayerWithoutNetwork', label: 'Count DOS and Windows games without network play as multiplayer', help: 'Off, the Multiplayer filter\'s 2+ and 3+ Players only list the DOS and Windows games that can be played with a friend over the network here. On, they also list Windows 95 games and ones where players take turns or share the keyboard.' },
];

/** The shelf's defaults, for everyone: each switch is saved as it's changed, and applies at their next visit. */
function shelfDefaultsCard(defaults) {
  const row = ({ flag, label, help, personal }) => h('label', { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: Boolean(defaults[flag]),
      dataset: { key: `shelf-${flag}` },
      onchange: async (e) => {
        const box = e.currentTarget;
        const on = box.checked;
        const saved = await act(box, () => api('/server-settings', { method: 'PUT', body: { shelfDefaults: { [flag]: on } } }), `${label}: ${on ? 'on' : 'off'} by default.`);
        if (!saved) box.checked = !on;
      },
    }),
    h('span', {}, h('b', {}, label), personal ? h('span', { class: 'tag' }, 'Each person can change') : null, h('span', { class: 'line2' }, help)));
  return card('What the shelf shows', 'What everyone sees until they change it. The first two anyone can change for themselves from their profile menu; the rest are yours alone. Open pages show a change once reloaded.',
    h('div', { class: 'checks' }, SHELF_DEFAULTS.map(row)));
}

/**
 * The public address invite links use. Without one a link is made from the address the host
 * started the game at, which a friend elsewhere can't open when that's this PC's or the network's.
 */
function publicUrlCard(s) {
  const input = h('input', { type: 'text', inputmode: 'url', id: 'public-url', value: s.publicUrl ?? '', placeholder: 'https://games.example.com', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Public address' });
  const save = async (value, button) => {
    const saved = await act(button, () => api('/server-settings', { method: 'PUT', body: { publicUrl: value } }),
      (r) => (r.publicUrl ? `Invite links now use ${r.publicUrl}.` : 'Invite links now use the address each game is started at.'));
    if (saved) loadServer();
  };
  // The names this server already answers to from outside (allowedHosts in the config), a click each.
  const offers = s.settings.allowedHosts.map((host) => `https://${host}`).filter((url) => url !== s.publicUrl);
  return card('Invite links', 'The address that links for playing with a friend open at: this site\'s public address, such as the tunnel\'s. Without one, a link uses the address the game was started at, which a friend elsewhere can\'t open when that\'s this PC\'s or the local network\'s.',
    h('p', {}, s.publicUrl ? ['Links use ', h('b', { class: 'mono' }, s.publicUrl), '.'] : [h('span', { class: 'tag' }, 'Not set'), ' Links use the address each game is started at.']),
    h('form', { class: 'public-url', onsubmit: (e) => { e.preventDefault(); save(input.value.trim() || null, e.submitter); } },
      input,
      h('button', { type: 'submit', class: 'button is-primary' }, 'Save'),
      s.publicUrl ? h('button', { type: 'button', class: 'button is-danger', onclick: (e) => save(null, e.currentTarget) }, 'Clear') : null),
    offers.length ? h('div', { class: 'buttons' }, h('span', { class: 'muted' }, 'Use:'),
      offers.map((url) => h('button', { type: 'button', class: 'button is-small', onclick: (e) => save(url, e.currentTarget) }, url))) : null);
}

/**
 * Where LaunchBox is. A new folder is checked first (as the setup page does), then saved to the
 * config; the server restarts to read it: an installed copy's service on its own, a copy run
 * from the project folder once the owner restarts it.
 */
function launchboxCard(s) {
  const lb = s.launchbox;
  const input = h('input', { type: 'text', value: lb.path, class: 'mono', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'LaunchBox folder' });
  const result = h('p', { class: 'muted', role: 'status' });
  const say = (text, cls = 'muted') => { result.className = cls; result.textContent = text; };
  const send = async (save, button) => {
    const path = input.value.trim();
    if (save && !confirm(lb.restarts
      ? `Use ${path}? The server restarts to read it, which stops the games being played right now.`
      : `Use ${path}? It takes effect once you restart the server.`)) return;
    button.disabled = true;
    say('Checking…');
    try {
      const r = await api('/admin/launchbox', { method: 'POST', body: { path, save } });
      const found = r.found.length ? `Found LaunchBox with ${plural(r.found.length, 'platform')} this site shows.` : 'Found LaunchBox, but none of the platforms this site shows.';
      if (!r.saved) return say(found, 'good');
      if (r.overridden) return say('Saved, but the LB_ROOT environment variable names another folder, and wins.', 'bad');
      if (!r.restarting) return say('Saved. Restart the server to use it.', 'good');
      say('Saved. Restarting…', 'good');
      await waitForRestart(s.build.startedAt);
      location.reload();
    } catch (err) {
      say(err.message, 'bad');
    } finally {
      if (button.isConnected) button.disabled = false;
    }
    return undefined;
  };
  return card('LaunchBox folder', 'The folder with LaunchBox.exe in it. It\'s only ever read.',
    h('form', { class: 'public-url launchbox-form', onsubmit: (e) => { e.preventDefault(); send(false, e.submitter); } },
      input,
      h('button', { type: 'submit', class: 'button' }, 'Check'),
      h('button', { type: 'button', class: 'button is-primary', onclick: (e) => send(true, e.currentTarget) }, lb.restarts ? 'Save and restart' : 'Save')),
    result,
    lb.fallbackRoots.length ? h('p', { class: 'muted' }, ['Also read from, for files missing there: ', h('span', { class: 'mono' }, lb.fallbackRoots.join(', ')), ' (fallbackRoots in the config).']) : null);
}

/** Waits for the server to come back from a restart: a start time other than `before`. */
async function waitForRestart(before) {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    try {
      const b = await api('/build');
      if (b.startedAt !== before) return;
    } catch {
      // Not back yet.
    }
  }
}

/**
 * The caches, and their sizes once measured: adding them up walks thousands of files, which
 * takes seconds, so it's done only when asked for (and kept while the page is open).
 */
function cachesCard(caches) {
  const sizes = page.cacheSizes;
  const measure = h('button', { type: 'button', class: 'button is-small', dataset: { key: 'measure-caches' }, onclick: (e) => measureCaches(e.currentTarget) },
    sizes ? 'Measure again' : 'Measure sizes');
  return card('Caches', 'Made again as they\'re needed, so clearing one only costs time: games take longer to start the next time. Games being played or downloaded are left alone.',
    table(
      ['', { text: 'Size', attrs: { class: 'num' } }, ''],
      caches.map((c) => {
        const size = sizes?.caches.find((m) => m.name === c.name);
        return h('tr', {},
          h('td', {}, h('span', {}, c.label), h('span', { class: 'line2' }, `${size ? `${count(size.files)} files · ` : ''}kept under ${bytes(c.limitBytes)}`)),
          h('td', { class: 'num' }, size ? bytes(size.bytes) : h('span', { class: 'muted' }, 'not measured')),
          h('td', { class: 'num' }, h('button', { type: 'button', class: 'button is-small is-danger', disabled: size ? !size.bytes : false, onclick: (e) => clearCache(e.currentTarget, c, size) }, 'Clear')));
      })),
    h('div', { class: 'buttons', style: 'margin-top: 10px' }, measure,
      sizes ? h('span', { class: 'stamp' }, ['Measured ', ago(sizes.at)]) : h('span', { class: 'stamp' }, 'Takes a few seconds.')));
}

async function measureCaches(button) {
  button.textContent = 'Measuring…';
  const result = await act(button, () => api('/admin/caches'));
  if (result) page.cacheSizes = { ...result, at: new Date().toISOString() };
  loadServer();
}

async function clearCache(button, c, size) {
  if (!confirm(`Clear ${c.label.toLowerCase()}${size ? ` (${bytes(size.bytes)})` : ''}?`)) return;
  const r = await act(button, () => api(`/admin/caches/${encodeURIComponent(c.name)}/clear`, { method: 'POST' }), (r) => `Freed ${bytes(r.freedBytes)}.`);
  // The clear measured what was left, so that one's size is known now either way.
  if (r) {
    const rest = (page.cacheSizes?.caches ?? []).filter((m) => m.name !== c.name);
    page.cacheSizes = { caches: [...rest, { name: c.name, bytes: r.leftBytes, files: r.leftFiles ?? 0 }], at: page.cacheSizes?.at ?? new Date().toISOString() };
  }
  loadServer();
}

start();
