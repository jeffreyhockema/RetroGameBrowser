// The setup page (public/setup.html), for a copy that hasn't been set up: where LaunchBox is, who
// can open the site, and how people sign in. Everything goes to /api/setup (see server/setup.js);
// once it's finished the server starts the app on the same port, which this page waits for.

import { $, h, api, plural } from './util.js';

const state = {
  info: null,
  checked: null,     // the last LaunchBox check that worked: { path, found, ... }
  checking: 0,
};

const checkedPath = () => $('#launchbox-path').value.trim();

// ---------- 1. LaunchBox ----------

async function check(path = checkedPath()) {
  $('#launchbox-path').value = path;
  const seq = ++state.checking;
  const out = $('#launchbox-result');
  out.className = 'result';
  out.replaceChildren(h('span', { class: 'stamp' }, 'Checking…'));
  let r;
  try {
    r = await api('/setup/launchbox', { method: 'POST', body: { path } });
  } catch (err) {
    r = { ok: false, problem: err.message };
  }
  if (seq !== state.checking) return null;
  state.checked = r.ok ? r : null;
  if (r.ok) {
    out.className = 'result is-ok';
    out.replaceChildren(...[
      h('span', {}, r.found.length ? `Found LaunchBox with ${plural(r.found.length, 'platform')} Retro Game Browser shows.` : 'Found LaunchBox, but none of the platforms Retro Game Browser shows.'),
      r.found.length ? h('span', { class: 'line2' }, r.found.join(', ')) : null,
      r.others ? h('span', { class: 'line2' }, `${plural(r.others, 'other platform')} it has aren't shown.`) : null].filter(Boolean));
  } else {
    out.className = 'result is-bad';
    out.replaceChildren(...[h('span', {}, r.problem),
      r.suggestion ? h('span', { class: 'line2' }, h('button', { type: 'button', class: 'button is-small', onclick: () => check(r.suggestion) }, `Use ${r.suggestion}`)) : null].filter(Boolean));
  }
  return r;
}

async function find() {
  const box = $('#found');
  let r;
  try {
    r = await api('/setup/find');
  } catch {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(...(r.found.length
    ? [h('span', { class: 'muted' }, r.found.length === 1 ? 'Found:' : 'Found these:'), ...r.found.map((dir) => h('button', { type: 'button', class: 'button is-small mono', onclick: () => check(dir) }, dir))]
    : [h('span', { class: 'stamp' }, 'LaunchBox wasn\'t found in the usual places: enter its folder below.')]));
  // The service can't look inside people's own folders, where LaunchBox usually is.
  if (state.info.installed && r.unreadableProfiles.length) {
    const hint = $('#profiles-hint');
    hint.hidden = false;
    hint.replaceChildren(`LaunchBox is often in a user folder (${r.unreadableProfiles.map((p) => `${p}\\LaunchBox`).join(', ')}), which the Retro Game Browser service, running as ${state.info.account}, isn't allowed to read. If yours is there, open RetroGameBrowser → "Run the service as a Windows account" in the Start menu first; this page will still be here.`);
  }
  if (!checkedPath() && r.found.length === 1) check(r.found[0]);
  // Nothing found, but a user folder it can't look in: where LaunchBox installs itself, most likely.
  else if (!checkedPath() && !r.found.length && r.unreadableProfiles.length) $('#launchbox-path').value = `${r.unreadableProfiles[0]}\\LaunchBox`;
}

// ---------- 3. Signing in ----------

function showOptions() {
  const google = $('#use-google').checked;
  const local = $('#use-local').checked;
  $('#google-options').hidden = !google;
  $('#local-options').hidden = !local;
  $('#no-signin').hidden = google || local;
  // With Google the owner is the Google address; without, it's a local account made here (unless
  // one was made before).
  const kept = state.info.localOwner;
  $('#local-owner').hidden = google || Boolean(kept);
  $('#local-owner-kept').hidden = google || !kept;
  $('#local-owner-kept').textContent = kept ? `You're the owner as the local account ${kept}, made before.` : '';
  origins();
}

function origins() {
  const host = $('#google-host').value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  const list = [`http://localhost:${state.info.port}`, host ? `https://${host}` : null].filter(Boolean);
  $('#google-origins').replaceChildren(...list.flatMap((o, i) => [i ? ' and ' : '', h('code', {}, o)]));
}

// ---------- Finish ----------

function fail(message, { step, field } = {}) {
  const box = $('#finish-error');
  box.textContent = message;
  box.hidden = false;
  for (const el of document.querySelectorAll('.field.is-bad')) el.classList.remove('is-bad');
  const input = {
    clientId: '#google-client', owner: '#google-owner', hostname: '#google-host', username: '#local-username', password: '#local-password',
  }[field];
  const target = input ? $(input) : step ? $(`#step-${step === 'google' || step === 'local' ? 'signin' : step}`) : null;
  if (input) $(input).closest('.field')?.classList.add('is-bad');
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (input) $(input).focus({ preventScroll: true });
}

async function finish() {
  $('#finish-error').hidden = true;
  const button = $('#finish');
  if (!state.checked || state.checked.path.toLowerCase() !== checkedPath().replace(/[\\/]+$/, '').toLowerCase()) {
    const r = await check();
    if (!r?.ok) return fail('Choose your LaunchBox folder first.', { step: 'launchbox' });
  }
  const google = $('#use-google').checked;
  const local = $('#use-local').checked;
  const needsOwner = local && !google && !state.info.localOwner;
  if (needsOwner && $('#local-password').value !== $('#local-password2').value) return fail('The two passwords aren\'t the same.', { field: 'password' });
  const body = {
    launchboxRoot: state.checked.path,
    network: document.querySelector('input[name="network"]:checked').value,
    google: google ? { clientId: $('#google-client').value, owner: $('#google-owner').value, hostname: $('#google-host').value } : null,
    local: local ? {
      enabled: true,
      signup: $('#local-signup').checked,
      owner: needsOwner ? { username: $('#local-username').value, name: $('#local-name').value, password: $('#local-password').value } : null,
    } : null,
  };
  button.disabled = true;
  button.textContent = 'Saving…';
  let r;
  try {
    const res = await fetch('/api/setup/finish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'RetroGameBrowser' }, body: JSON.stringify(body) });
    r = await res.json().catch(() => ({ error: `Setup couldn't be saved (${res.status}).` }));
    if (!res.ok) throw Object.assign(new Error(r.error || `Setup couldn't be saved (${res.status}).`), { step: r.step, field: r.field });
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Finish setup';
    // The answer says which step and field are wrong, when it's one of them.
    return fail(err.message, { step: err.step, field: err.field });
  }
  done(r, body);
  return undefined;
}

/** Setup is saved: says what comes next, and waits for the app to answer on this port. */
function done(r, body) {
  $('#setup').hidden = true;
  $('#done').hidden = false;
  window.scrollTo(0, 0);
  const port = state.info.port;
  const items = [];
  if (r.google) {
    items.push(['Sign in with Google as ', h('b', {}, body.google.owner.trim().toLowerCase()), ' (profile menu, top right), here or at ', r.hostname ? h('code', {}, `https://${r.hostname}`) : 'your tunnel\'s address', '. The admin page is in the same menu.']);
  }
  if (r.local && r.localOwner && !r.google) {
    items.push(['Sign in as ', h('b', {}, r.localOwner), ': profile menu (top right) → Sign in with Local Account. The admin page is in the same menu, where you add accounts for other people.']);
  } else if (r.local) {
    items.push('Local accounts are on: add them on the admin page\'s Accounts tab.');
  }
  if (!r.google && !r.local) items.push('Everyone on your network can play. The admin page opens only on this PC (profile menu, top right).');
  if (r.host === '0.0.0.0') items.push(['Other devices on your network open it at ', h('code', {}, `http://${state.info.pcName}:${port}`), ' (or this PC\'s IP address).']);
  items.push(['The server\'s log is in ', h('code', {}, state.info.logsDir), ', and on the admin page\'s Server tab. Settings are in ', h('code', {}, state.info.configFile), '.']);
  $('#next').replaceChildren(...items.map((item) => h('li', {}, item)));
  waitForApp();
}

/** The setup server answers /api/setup; the app, once it's up, doesn't. */
async function waitForApp() {
  for (;;) {
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
    try {
      const res = await fetch('/api/setup', { cache: 'no-store' });
      if (res.status === 200 && (await res.json().catch(() => ({}))).setup) continue;
      break;
    } catch {
      // Between the two: nothing answers for a moment.
    }
  }
  $('#done-title').textContent = 'Retro Game Browser is running';
  $('#done-sub').textContent = 'It may still be reading your library for a minute; the page shows when it\'s ready.';
  $('#open').removeAttribute('aria-disabled');
}

// ---------- Start ----------

async function start() {
  try {
    state.info = await api('/setup');
  } catch (err) {
    $('#setup').replaceChildren(h('p', { class: 'error' }, `Couldn't reach the setup: ${err.message}`));
    return;
  }
  const info = state.info;
  $('#network-help').textContent = `Phones, tablets, TVs and other computers open it at http://${info.pcName}:${info.port}. Anyone on your network can play without signing in.`;
  if (info.current.host === '127.0.0.1') document.querySelector('input[name="network"][value="this-pc"]').checked = true;
  if (info.current.google) {
    $('#use-google').checked = true;
    $('#google-client').value = info.current.google.clientId;
    $('#google-owner').value = info.current.google.owner;
    $('#google-host').value = info.current.google.hostname;
  }
  if (info.localOwner) $('#use-local').checked = true;
  if (info.current.launchboxRoot) check(info.current.launchboxRoot);
  showOptions();

  $('#launchbox-form').addEventListener('submit', (e) => { e.preventDefault(); check(); });
  $('#use-google').addEventListener('change', showOptions);
  $('#use-local').addEventListener('change', showOptions);
  $('#google-host').addEventListener('input', origins);
  $('#finish').addEventListener('click', finish);
  find();
}

start();
