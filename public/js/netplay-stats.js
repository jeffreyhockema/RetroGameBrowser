// The multiplayer stats page: a game with friends reports everything about itself once a
// second on a channel every tab of this site can hear (see `detail` in
// public/player/netplay-fixes.js); this page shows the latest from each game, and which build
// the server runs against what this browser actually gets for each file of the app, fetched
// past the browser's own cache, so a copy kept somewhere between (a CDN in front of a tunnel)
// shows as stale.

import { $, h } from './util.js';

const KEY_FILES = ['/player/netplay-fixes.js', '/emu/play.html', '/js/join.js', '/js/player.js', '/js/netstats.js', '/js/util.js', '/js/room.js', '/js/app.js', '/index.html', '/join.html', '/js/netplay-stats.js', '/netplay-stats.html', '/app.css'];
const GONE_MS = 5000; // a game that hasn't reported for this long has left

const games = new Map(); // key -> latest detail
let build = null;
let checks = null;

// ---------- The build ----------

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes)).slice(0, 12);
}

/** Each key file as this browser gets it now, past its own cache, against the server's hash. */
async function checkFiles() {
  if (!build?.files) return;
  const results = [];
  for (const file of KEY_FILES) {
    if (!(file in build.files)) continue;
    try {
      const res = await fetch(file, { cache: 'reload' });
      const got = await sha256(await res.arrayBuffer());
      results.push({ file, server: build.files[file], got, fresh: got === build.files[file], via: res.headers.get('cf-cache-status') });
    } catch (err) {
      results.push({ file, server: build.files[file], got: null, fresh: false, error: err.message });
    }
  }
  checks = results;
  renderBuild();
}

async function loadBuild() {
  try {
    const res = await fetch('/api/build', { cache: 'no-store' });
    build = await res.json();
  } catch (err) {
    build = { error: err.message };
  }
  renderBuild();
  await checkFiles();
}

function renderBuild() {
  const box = $('#build');
  if (!build) return;
  if (build.error) {
    box.replaceChildren(h('h2', {}, 'Build'), h('p', { class: 'bad' }, `The server didn't answer: ${build.error}`));
    return;
  }
  const stale = checks?.filter((c) => !c.fresh) ?? [];
  box.replaceChildren(
    h('h2', {}, 'Build'),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Server build'), h('dd', {}, h('span', { class: 'mono' }, build.build), build.dirty ? h('span', { class: 'muted' }, ' (with changes not yet committed)') : null),
      h('dt', {}, 'Commit'), h('dd', { class: 'mono' }, build.commit ?? 'no git'),
      h('dt', {}, 'Server started'), h('dd', {}, new Date(build.startedAt).toLocaleString(), h('span', { class: 'muted' }, ` · Node ${build.node}`)),
      h('dt', {}, 'This page'), h('dd', {}, location.origin, h('span', { class: 'muted' }, ` · ${navigator.userAgent}`))),
    h('h3', {}, 'The app\'s files, as this browser gets them'),
    checks ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Server has'), h('th', {}, 'Browser gets'), h('th', {}, 'Edge'), h('th', {}, ''))),
      h('tbody', {}, checks.map((c) => h('tr', {},
        h('td', { class: 'mono' }, c.file),
        h('td', { class: 'mono' }, c.server),
        h('td', { class: 'mono' }, c.got ?? c.error ?? '?'),
        h('td', { class: 'muted' }, c.via ?? '—'),
        h('td', { class: c.fresh ? 'ok' : 'bad' }, c.fresh ? 'fresh' : 'STALE')))))
      : h('p', { class: 'muted' }, 'Checking…'),
    stale.length ? h('p', { class: 'bad' }, `${stale.length} file(s) reach this browser in an older version than the server has: a cache between them (Cloudflare's, say) is serving old copies. The server now sends CDN-Cache-Control: no-store for its own files; purge the cache once and check again.`)
      : checks ? h('p', { class: 'ok' }, 'Every file is the server\'s current version.') : null);
}

// ---------- The games ----------

const ms = (n) => (n == null ? '—' : `${Math.round(n)} ms`);
const num = (n) => (n == null ? '—' : String(n));
const kb = (n) => (n == null ? '—' : `${(n / 1024).toFixed(1)} KB`);

function spark(values, max) {
  const top = max ?? Math.max(1, ...values);
  return h('span', { class: 'spark', title: values.join(', ') }, values.slice(-60).map((v) => h('i', { style: `height:${Math.max(1, Math.round((v / top) * 22))}px` })));
}

/** Whether some text inside `el` is selected, which a redraw would throw away. */
const selecting = (el) => {
  const selection = getSelection();
  return !!selection && !selection.isCollapsed && el.contains(selection.anchorNode);
};

function renderGames() {
  const now = Date.now();
  for (const [key, d] of games) if (now - d.at > GONE_MS) games.delete(key);
  const box = $('#games');
  // Redrawn every second or more, so it waits while text in it is being selected, and keeps
  // each log where it was scrolled to.
  if (selecting(box)) return;
  const scrolls = new Map([...box.querySelectorAll('pre.log')].map((p) => [p.dataset.key, p.scrollTop]));
  $('#waiting').hidden = games.size > 0;
  box.replaceChildren(...[...games].sort((a, b) => a[1].player - b[1].player).map(([key, d]) => renderGame(d, key)));
  for (const p of box.querySelectorAll('pre.log')) if (scrolls.get(p.dataset.key)) p.scrollTop = scrolls.get(p.dataset.key);
  $('#stamp').textContent = games.size ? `Updated ${new Date().toLocaleTimeString()}` : '';
}

function renderGame(d, key) {
  const e = d.engine ?? {};
  const st = d.stats ?? {};
  const r = d.rates ?? {};
  return h('section', { class: 'card' },
    h('h2', {}, `${d.role === 'host' ? 'Host' : 'Friend'}: player ${d.player}${d.room?.name ? ` (${d.room.name})` : ''}`, h('span', { class: 'muted' }, ` · ${d.room?.title ?? ''}`)),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Players'), h('dd', {}, (d.players ?? []).map((n, i) => `${i + 1}: ${n}`).join(', ') || '—'),
      h('dt', {}, 'Room'), h('dd', { class: 'mono' }, d.room?.code ?? '—'),
      h('dt', {}, 'Input lag'), h('dd', {}, ms(st.lag), ' ', d.lags?.length ? spark(d.lags, 250) : null, h('span', { class: 'muted' }, ` (${d.lags?.length ?? 0} presses in 10 s)`)),
      h('dt', {}, 'Ping'), h('dd', {}, ms(st.ping), h('span', { class: 'muted' }, ` · ${st.transport ?? '—'}`)),
      h('dt', {}, 'Delay'), h('dd', {}, `${num(st.delay)} frames`, h('span', { class: 'muted' }, st.delay != null ? ` (${Math.round((st.delay + 1) * 1000 / 60)} ms press to core)` : '')),
      h('dt', {}, 'Others ahead by'), h('dd', {}, `${num(st.ahead)} frames`),
      h('dt', {}, 'Stalls'), h('dd', {}, `${num(st.stalls)} in 10 s, ${ms(st.stalled)}`, ' ', d.stalls?.length ? spark(d.stalls, 100) : null),
      h('dt', {}, 'Mode'), h('dd', {}, st.mode ?? '—',
        st.mode === 'rollback' ? h('span', { class: 'muted' }, ` · ${num(st.rollbacks)} rollbacks in 10 s, median ${num(st.rollbackFrames)} frames, ${ms(st.rollbackMs)} each · confirmed to frame ${num(e.confirmed)} · ${num(e.states)} states kept${e.statesMissed ? `, ${num(e.statesMissed)} frames the game couldn't be caught on` : ''}`) : null,
        st.mode === 'stream' ? h('span', { class: 'muted' }, ` · source ${st.source ? `${st.source.width}×${st.source.height} at ${Math.round(st.source.fps ?? 0)} fps` : '—'}${st.audio ? ', with sound' : ', no sound captured'}`) : null),
      st.mode === 'stream' ? h('dt', {}, 'Friends') : null,
      st.mode === 'stream' ? h('dd', {}, Object.entries(st.guests ?? {}).map(([p, g]) => `player ${p}: presses ${ms(g.ping)} ${g.transport ?? ''}, video ${num(g.videoFps)} fps at ${num(g.videoKbps)} kbps${g.videoWidth ? ` (${g.videoWidth}×${g.videoHeight})` : ''}${g.limited ? `, encoder held back by ${g.limited}` : ''}${g.encodeMs != null ? `, ${ms(g.encodeMs)} to encode` : ''}${g.viewer?.jitterMs != null ? `, their buffer ${ms(g.viewer.jitterMs)}` : ''}`).join(' · ') || 'nobody yet') : null,
      h('dt', {}, 'Divergences'), h('dd', { class: st.mismatches ? 'bad' : '' }, `${num(st.mismatches)} found, ${num(st.resyncs)} resyncs`),
      h('dt', {}, 'Frame'), h('dd', {}, `${num(e.frame)} of hand-over ${num(e.gen)}`, h('span', { class: 'muted' }, ` · count ${num(e.count)}, origin ${num(e.init)} · vouched to ${num(e.upto)} · ${e.waiting ? 'waiting' : e.syncing ? 'syncing' : 'running'}${e.paused ? ', paused' : ''} · ${num(e.pending)} pending · hash every ${num(e.hashEvery)}`)),
      h('dt', {}, 'This second'), h('dd', {}, `${num(r.frames)} frames in ${num(r.ticks)} ticks · ${num(r.packetsOut)} packets out (${kb(r.bytesOut)}), ${num(r.packetsIn)} in (${kb(r.bytesIn)})`),
      h('dt', {}, 'Socket'), h('dd', {}, d.socket?.connected ? `connected (${d.socket.transport ?? '?'})` : h('span', { class: 'bad' }, 'not connected')),
      h('dt', {}, 'Browser'), h('dd', {}, d.browser?.hidden ? h('span', { class: 'bad' }, 'TAB HIDDEN: the emulator runs at a frame a second while its tab is hidden, and everyone waits for it. Keep the game visible. · ') : null, `${d.browser?.cores ?? '?'} cores · ${d.browser?.dpr}x · ${d.browser?.ua ?? ''}`)),
    h('h3', {}, 'Other players, as this side sees them'),
    d.peers?.length ? h('table', {},
      h('thead', {}, h('tr', {}, ...['Player', 'Transport', 'Path', 'RTT', 'Their frame', 'Vouched', 'Usable', 'Inputs had', 'Acked of mine', 'Buffered'].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.peers.map((p) => h('tr', {},
        h('td', {}, `${p.player}${p.name ? ` ${p.name}` : ''}`),
        h('td', { class: p.transport === 'direct' ? 'ok' : '' }, p.transport),
        h('td', {}, p.path ? `${p.path.local ?? '?'} → ${p.path.remote ?? '?'} ${p.path.protocol ?? ''}` : '—'),
        h('td', { class: 'num' }, p.rtt != null ? ms(p.rtt) : p.socketRtt != null ? `${ms(p.socketRtt)} (socket)` : '—'),
        h('td', { class: 'num' }, num(p.theirFrame)),
        h('td', { class: 'num' }, num(p.upto)),
        h('td', { class: 'num' }, num(p.effectiveVouch)),
        h('td', { class: 'num' }, num(p.contig + 1)),
        h('td', { class: 'num' }, num(p.ackOfMe + 1)),
        h('td', { class: 'num' }, `${num(p.buffered)}${p.checksWaiting ? ` +${p.checksWaiting} hashes` : ''}`)))))
      : h('p', { class: 'muted' }, 'Nobody else is in the room yet.'),
    h('h3', {}, 'Log'),
    h('pre', { class: 'log', 'data-key': key }, (d.log ?? []).join('\n') || '—'));
}

// ---------- Past sessions: the server's log of each game (server/lib/netplaylog.js) ----------

const COLORS = ['#5cc4e0', '#f4d35e', '#7be495', '#ff8f7a'];
let sessions = null;
let shown = null; // the name of the session drawn
let showing = 0; // the latest showSession, so an older answer can't replace a newer pick
let refreshedAt = 0; // when the shown session was last fetched
// Each refresh of a live session fetches and draws its whole log, in the same browser (often the
// same thread) as the game being measured, so not too often.
const LIVE_REFRESH_MS = 30_000;

const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const duration = (ms) => (ms == null ? '—' : ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

const isLive = (name) => !!name && Array.isArray(sessions) && sessions.some((x) => x.name === name && x.live);

async function loadSessions({ force = false } = {}) {
  const box = $('#sessions');
  let res;
  try {
    res = await fetch('/api/netplay/logs', { cache: 'no-store' });
  } catch (err) {
    box.replaceChildren(h('h2', {}, 'Sessions'), h('p', { class: 'bad' }, `The server didn't answer: ${err.message}`));
    return;
  }
  // The log is only for accounts that may play (a friend invited to a game opens this page
  // too); to anyone else the server says there's no such thing, and the page leaves it out.
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    sessions = null;
    box.hidden = true;
    return;
  }
  let list;
  try {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    list = await res.json();
  } catch (err) {
    box.replaceChildren(h('h2', {}, 'Sessions'), h('p', { class: 'bad' }, `The server didn't answer: ${err.message}`));
    return;
  }
  const wasLive = isLive(shown);
  sessions = Array.isArray(list) ? list : [];
  box.hidden = false;
  renderSessions();
  // The shown session again while it's live, and once more as it ends, for its last seconds
  // and its end. Asked for (the Refresh button) at once; otherwise every LIVE_REFRESH_MS while
  // this page is on screen.
  const live = isLive(shown);
  if ((wasLive && !live) || (live && (force || (!document.hidden && Date.now() - refreshedAt >= LIVE_REFRESH_MS)))) showSession(shown, { quiet: true });
}

function renderSessions() {
  const box = $('#sessions');
  const rows = sessions ?? [];
  box.replaceChildren(
    h('h2', {}, 'Sessions', h('span', { class: 'muted' }, ` · ${rows.length} on the server, newest first`)),
    h('p', { class: 'muted' }, 'Every game with friends is logged on the server as it goes: each player\'s numbers once a second and what happened. Pick one to see how the lag, ping and stalls went over the game.'),
    rows.length ? h('table', { class: 'sessions' },
      h('thead', {}, h('tr', {}, ...['Started', 'Game', 'Mode', 'Players', 'Length', 'Median lag / ping', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((x) => h('tr', { class: x.live ? 'is-live' : '' },
        h('td', {}, when(x.started), x.live ? h('span', { class: 'ok' }, ' live') : x.ended ? null : h('span', { class: 'muted' }, ' (cut short)')),
        h('td', {}, x.title, h('span', { class: 'muted' }, x.platform ? ` · ${x.platform}` : '')),
        h('td', {}, x.mode ?? '—'),
        h('td', {}, (x.players ?? []).map((p) => p.name || `player ${p.p}`).join(', ') || x.host || '—'),
        h('td', {}, duration(x.duration)),
        h('td', {}, (x.players ?? []).map((p) => `${p.name || p.p}: ${p.lag != null ? Math.round(p.lag) : '—'} / ${p.ping != null ? Math.round(p.ping) : '—'} ms`).join(' · ') || '—'),
        h('td', {}, h('button', { type: 'button', 'data-session': x.name }, x.name === shown ? 'Shown' : 'Show'))))))
      : h('p', { class: 'muted' }, 'No game has been played with a friend since logging began.'),
    h('p', {}, h('button', { type: 'button', id: 'reload-sessions' }, 'Refresh the list')));
  box.querySelectorAll('button[data-session]').forEach((b) => b.addEventListener('click', () => showSession(b.dataset.session)));
  $('#reload-sessions').addEventListener('click', () => loadSessions({ force: true }));
}

async function showSession(name, { quiet = false } = {}) {
  // A refresh is only for the session still shown, so it can't bring back one the user has
  // just moved away from; and whichever call came last wins.
  if (quiet && name !== shown) return;
  const my = ++showing;
  const box = $('#session');
  box.hidden = false;
  if (!quiet) {
    shown = name;
    box.replaceChildren(h('h2', {}, 'Session'), h('p', { class: 'muted' }, 'Loading…'));
  }
  let data;
  try {
    const res = await fetch(`/api/netplay/logs/${encodeURIComponent(name)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    if (my !== showing) return;
    box.replaceChildren(h('h2', {}, 'Session'), h('p', { class: 'bad' }, `Couldn't load it: ${err.message}`));
    return;
  }
  if (my !== showing) return;
  refreshedAt = Date.now();
  // A refresh waits while text in the box is selected, and keeps the events where they were
  // scrolled to.
  if (quiet && selecting(box)) return;
  const eventsTop = box.querySelector('pre.events')?.scrollTop ?? 0;
  renderSession(data);
  if (quiet && eventsTop) box.querySelector('pre.events').scrollTop = eventsTop;
  if (sessions) renderSessions();
  if (!quiet) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** One session drawn: its facts, a chart each for lag, ping and stalls or rollbacks, and its events. */
function renderSession(data) {
  const box = $('#session');
  const t0 = data.session.at;
  const players = new Map(); // p -> { name, samples }
  for (const smp of data.samples) {
    if (!players.has(smp.p)) players.set(smp.p, { name: smp.name || `player ${smp.p}`, samples: [] });
    players.get(smp.p).samples.push(smp);
  }
  for (const e of data.events) if (!players.has(e.p) && e.what === 'joined') players.set(e.p, { name: e.name || `player ${e.p}`, samples: [] });
  const list = [...players].sort((a, b) => a[0] - b[0]);
  const end = data.end;
  // Loops rather than Math.max(...): a long game has more records than a call takes arguments.
  let last = Math.max(t0 + 1000, end?.at ?? 0);
  for (const x of data.samples) if (x.at > last) last = x.at;
  for (const x of data.events) if (x.at > last) last = x.at;
  const series = (key) => list.map(([p, pl], i) => ({ name: pl.name, color: COLORS[(p - 1) % COLORS.length], points: pl.samples.filter((x) => x[key] != null).map((x) => [x.at - t0, x[key]]) }));
  const legend = h('p', { class: 'legend' }, list.map(([p, pl]) => h('span', {}, h('i', { style: `background:${COLORS[(p - 1) % COLORS.length]}` }), `${p}: ${pl.name}`)));
  const lagC = h('canvas', { class: 'chart' });
  const pingC = h('canvas', { class: 'chart' });
  const stallC = h('canvas', { class: 'chart' });
  const rollback = data.session.mode === 'rollback';
  const hidden = data.samples.filter((x) => x.hidden).map((x) => x.at - t0);
  const bad = data.events.filter((e) => /diverged|sync:|asked for a fresh state|can't roll back/.test(e.what)).map((e) => e.at - t0);
  box.replaceChildren(
    h('h2', {}, `${data.session.title}`, h('span', { class: 'muted' }, ` · ${when(t0)}${data.live ? ' · live' : ''}`)),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Mode'), h('dd', {}, data.session.mode ?? '—', h('span', { class: 'muted' }, data.session.platform ? ` · ${data.session.platform}` : '')),
      h('dt', {}, 'Length'), h('dd', {}, duration((end?.at ?? last) - t0), h('span', { class: 'muted' }, ` · ${data.samples.length} samples, ${data.events.length} events${data.live ? '' : end ? '' : ' · no end record: the server stopped before the game did'}`)),
      h('dt', {}, 'Players'), h('dd', {}, list.length ? h('table', {},
        h('thead', {}, h('tr', {}, ...['Player', 'Samples', 'Median lag', 'Median ping', 'Worst ping', 'Transport', 'Stalls', rollback ? 'Rollbacks' : 'Divergences'].map((t) => h('th', {}, t)))),
        h('tbody', {}, list.map(([p, pl]) => {
          const lags = pl.samples.map((x) => x.lag).filter((v) => v != null);
          const pings = pl.samples.map((x) => x.ping).filter((v) => v != null);
          const transports = [...new Set(pl.samples.map((x) => x.transport).filter(Boolean))];
          // The stalls and rollbacks are ten-second windows sampled every second: summing every
          // tenth sample counts each once, near enough.
          const windows = (key) => pl.samples.filter((_, i) => i % 10 === 9 || i === pl.samples.length - 1).reduce((sum, x) => sum + (x[key] ?? 0), 0);
          const lastOf = (key) => pl.samples.length ? pl.samples[pl.samples.length - 1][key] ?? 0 : 0;
          return h('tr', {},
            h('td', {}, `${p}: ${pl.name}`),
            h('td', { class: 'num' }, pl.samples.length),
            h('td', { class: 'num' }, ms(med(lags))),
            h('td', { class: 'num' }, ms(med(pings))),
            h('td', { class: 'num' }, ms(pings.length ? pings.reduce((m, v) => (v > m ? v : m)) : null)),
            h('td', {}, transports.join(', ') || '—'),
            h('td', { class: 'num' }, `~${windows('stalls')}`),
            h('td', { class: 'num' }, rollback ? `~${windows('rollbacks')}` : `${lastOf('mismatches')} (${lastOf('resyncs')} resyncs)`));
        })))
        : h('span', { class: 'muted' }, 'nobody reported'))),
    h('h3', {}, 'Input lag, ms (each player\'s own presses, press to screen)'), legend.cloneNode(true), lagC,
    h('h3', {}, 'Ping, ms (the slowest round trip each player sees)'), legend.cloneNode(true), pingC,
    h('h3', {}, rollback ? 'Rollbacks in the last 10 s, and stalls' : 'Stalls in the last 10 s'), legend.cloneNode(true), stallC,
    h('p', { class: 'muted' }, 'Red ticks along the bottom: divergences, fresh states and resync requests. Grey: a tab was hidden.'),
    h('h3', {}, 'Events'),
    h('pre', { class: 'log events' }, data.events.length ? data.events.map((e) => `${clock(e.at - t0)}  p${e.p} ${e.name ? `${e.name} ` : ''}${e.what}`).join('\n') : '—'));
  const span = last - t0;
  drawChart(lagC, series('lag'), { span, marks: bad, greys: hidden, unit: 'ms' });
  drawChart(pingC, series('ping'), { span, marks: bad, greys: hidden, unit: 'ms' });
  drawChart(stallC, rollback ? series('rollbacks') : series('stalls'), { span, marks: bad, greys: hidden, unit: '', bars: true, extra: rollback ? series('stalls') : null });
}

function med(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** A line chart of several series over the session's time, with a scale that fits the data. */
function drawChart(canvas, series, { span, marks = [], greys = [], unit = '', bars = false, extra = null }) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  const hgt = canvas.clientHeight || 190;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const iw = w - pad.l - pad.r;
  const ih = hgt - pad.t - pad.b;
  const all = [...series, ...(extra ?? [])].flatMap((s) => s.points.map((p) => p[1]));
  const top = niceMax(all.reduce((m, v) => (v > m ? v : m), 1));
  const x = (t) => pad.l + (t / Math.max(1, span)) * iw;
  const y = (v) => pad.t + ih - (Math.min(v, top) / top) * ih;
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  // Grid and scale.
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i;
    ctx.strokeStyle = '#223549';
    ctx.beginPath();
    ctx.moveTo(pad.l, y(v));
    ctx.lineTo(w - pad.r, y(v));
    ctx.stroke();
    ctx.fillStyle = '#93a6bb';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(v)}${unit ? ` ${unit}` : ''}`, pad.l - 6, y(v));
  }
  const step = span > 20 * 60_000 ? 5 * 60_000 : span > 5 * 60_000 ? 60_000 : span > 60_000 ? 30_000 : 10_000;
  ctx.textAlign = 'center';
  for (let t = 0; t <= span; t += step) {
    ctx.fillStyle = '#93a6bb';
    ctx.fillText(clock(t), x(t), hgt - pad.b / 2);
  }
  // Hidden tabs and trouble, as ticks along the bottom.
  for (const t of greys) {
    ctx.fillStyle = 'rgba(147,166,187,0.5)';
    ctx.fillRect(x(t) - 1, pad.t, 2, ih);
  }
  for (const t of marks) {
    ctx.fillStyle = '#ff8f7a';
    ctx.fillRect(x(t) - 1, pad.t + ih - 10, 2, 10);
  }
  // The series.
  const draw = (s, dashed) => {
    if (!s.points.length) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(dashed ? [3, 3] : []);
    if (bars && !dashed) {
      ctx.fillStyle = s.color;
      for (const [t, v] of s.points) if (v > 0) ctx.fillRect(x(t) - 1, y(v), 2, pad.t + ih - y(v));
      return;
    }
    ctx.beginPath();
    let pen = false;
    let lastT = null;
    for (const [t, v] of s.points) {
      // A gap of more than a few seconds (a page gone, a reload) breaks the line.
      if (pen && lastT != null && t - lastT > 5000) pen = false;
      if (!pen) ctx.moveTo(x(t), y(v));
      else ctx.lineTo(x(t), y(v));
      pen = true;
      lastT = t;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };
  for (const s of series) draw(s, false);
  for (const s of extra ?? []) draw(s, true);
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// ---------- Plumbing ----------

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('rgb-netplay') : null;
channel?.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || typeof d !== 'object' || !d.role) return;
  games.set(`${d.role}:${d.room?.code ?? ''}:${d.player}`, d);
  renderGames();
});
setInterval(renderGames, 1000);

$('#copy').addEventListener('click', async () => {
  const report = { at: new Date().toISOString(), page: location.href, build, files: checks, games: [...games.values()] };
  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $('#copy').textContent = 'Copied';
  } catch {
    const box = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' });
    box.value = text;
    document.body.append(box);
    box.select();
    document.execCommand('copy');
    box.remove();
    $('#copy').textContent = 'Copied';
  }
  setTimeout(() => { $('#copy').textContent = 'Copy report'; }, 2000);
});
$('#recheck').addEventListener('click', loadBuild);

if (!channel) $('#waiting').textContent = 'This browser can\'t listen to the game (no BroadcastChannel).';
loadBuild();
loadSessions();
setInterval(() => { if (Array.isArray(sessions) && (sessions.some((x) => x.live) || shown)) loadSessions(); }, 10_000);
