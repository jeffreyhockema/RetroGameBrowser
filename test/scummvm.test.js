import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCommandLine, parseIni, parseExoLauncher, buildVersions, labelVersions,
  defaultSound, qualifyGameId, webArguments,
} from '../server/lib/scummvm.js';
import { classifyVersion, flagPlatformName } from '../server/lib/versionkind.js';

// Trimmed from eXo's Day of the Tentacle launcher.
const DOTT_BAT = [
  '@echo off',
  ':dfsb',
  '".\\scmvm\\scummvm.exe" --no-console -F -g3x --platform=pc --opl-driver=nuked --output-rate=44100 --aspect-ratio -p".\\eXoScummVM\\Day Of The Tentacle (Multi-Platform)\\Day Of the Tentacle (Floppy DOS)" tentacle',
  ':dfmt32',
  '".\\scmvm\\scummvm.exe" --no-console -F -g3x --platform=pc --opl-driver=nuked -emt32 --multi-midi --extrapath=.\\mt32\\ --output-rate=44100 --aspect-ratio -p".\\eXoScummVM\\Day Of The Tentacle (Multi-Platform)\\Day Of the Tentacle (Floppy DOS)" tentacle',
  ':mac',
  '".\\scmvm\\scummvm.exe" --no-console -F -g3x --platform=macintosh --opl-driver=nuked --output-rate=44100 --aspect-ratio -p".\\eXoScummVM\\%GameDir%\\Day Of The Tentacle (Macintosh)" tentacle',
  'rem ".\\scmvm\\scummvm.exe" -p".\\eXoScummVM\\ignored" tentacle',
].join('\r\n');

const ENGINES = { tentacle: ['scumm'], Soccer2004: ['scumm'], sky: ['sky'], openquest: ['ags', 'wintermute'] };

test('splitCommandLine keeps quoted parts together', () => {
  assert.deepEqual(splitCommandLine('"a b.exe" -p".\\x y\\z" id'), ['a b.exe', '-p.\\x y\\z', 'id']);
});

test('parseIni reads sections', () => {
  assert.deepEqual(parseIni('[scummvm]\nmute=false\n\n[t7g-ios]\ngameid=t7g\nengineid=groovie\n'),
    { scummvm: { mute: 'false' }, 't7g-ios': { gameid: 't7g', engineid: 'groovie' } });
});

test('parseExoLauncher reads every scummvm.exe line and skips comments', () => {
  const cmds = parseExoLauncher(DOTT_BAT, 'Day Of The Tentacle (Multi-Platform)');
  assert.equal(cmds.length, 3);
  assert.equal(cmds[0].dataRel, 'eXoScummVM\\Day Of The Tentacle (Multi-Platform)\\Day Of the Tentacle (Floppy DOS)');
  assert.equal(cmds[0].target, 'tentacle');
  assert.equal(cmds[1].sound, 'mt32');
  assert.equal(cmds[1].options['multi-midi'], true);
  assert.equal(cmds[2].dataRel, 'eXoScummVM\\Day Of The Tentacle (Multi-Platform)\\Day Of The Tentacle (Macintosh)', '%GameDir% is expanded');
  assert.equal(cmds[0].options['opl-driver'], undefined, 'native-only options are dropped');
});

test('parseExoLauncher expands variables set by the launcher menu', () => {
  const bat = [
    'set TYPE=ultima6_enh', 'set SCALE=g2x', 'goto towns',
    'set TYPE=ultima6', 'set SCALE=g3x', 'goto towns',
    '".\\scmvm\\scummvm.exe" --no-console -F -%SCALE% --platform=pc -p".\\eXoScummVM\\%GameDir%" %TYPE%',
  ].join('\r\n');
  const versions = buildVersions(parseExoLauncher(bat, 'Ultima VI'), {}, { ultima6: ['ultima'], ultima6_enh: ['ultima'] });
  assert.deepEqual(versions.map((v) => v.gameId), ['ultima:ultima6_enh', 'ultima:ultima6']);
  assert.deepEqual(labelVersions(versions, 'Ultima VI', 'Ultima VI'), ['Ultima VI, enhanced', 'Ultima VI, original']);

  // A variable that isn't set doesn't stop the ones after it; one that names itself doesn't loop.
  const unset = buildVersions(parseExoLauncher(bat.replace('--no-console', '--no-console %OPT%'), 'Ultima VI'), {}, { ultima6: ['ultima'], ultima6_enh: ['ultima'] });
  assert.deepEqual(unset.map((v) => v.gameId), ['ultima:ultima6_enh', 'ultima:ultima6']);
  const own = parseExoLauncher(['set OPT=--subtitles', 'set OPT=%OPT% --fullscreen', '".\\scmvm\\scummvm.exe" %OPT% -p".\\eXoScummVM\\X" x'].join('\r\n'), 'X');
  assert.deepEqual(own.map((c) => c.target), ['x', 'x']);
});

test('buildVersions groups music choices under one version', () => {
  const versions = buildVersions(parseExoLauncher(DOTT_BAT, 'Day Of The Tentacle (Multi-Platform)'), {}, ENGINES);
  assert.equal(versions.length, 2);
  assert.deepEqual(versions[0].sounds.map((s) => s.driver), ['default', 'mt32']);
  assert.equal(versions[0].gameId, 'scumm:tentacle');
  assert.equal(versions[1].platform, 'macintosh');
});

test('buildVersions expands targets from eXo\'s scummvm.ini', () => {
  const bat = '".\\scmvm\\scummvm.exe" --config=.\\scmvm\\scummvm.ini -p".\\eXoScummVM\\G\\The 7th Guest (iOS)" t7g-ios';
  const ini = { 't7g-ios': { gameid: 't7g', engineid: 'groovie', platform: 'ios', language: 'en' } };
  const [v] = buildVersions(parseExoLauncher(bat, 'G'), ini, {});
  assert.equal(v.gameId, 'groovie:t7g');
  assert.equal(v.platform, 'ios');
  assert.equal(v.autoDetect, false);
});

test('qualifyGameId adds the engine, matching case, or gives up when ambiguous', () => {
  assert.equal(qualifyGameId('tentacle', ENGINES), 'scumm:tentacle');
  assert.equal(qualifyGameId('Sky', ENGINES), 'sky:sky');
  assert.equal(qualifyGameId('Soccer2004', ENGINES), 'scumm:Soccer2004');
  assert.equal(qualifyGameId('openquest', ENGINES), null);
  assert.equal(qualifyGameId('unknown', ENGINES), null);
  assert.equal(qualifyGameId('sci:kq6', ENGINES), 'sci:kq6');
  // A target named like something every object has isn't found in the map.
  assert.equal(qualifyGameId('toString', ENGINES), null);
  assert.equal(qualifyGameId('constructor', ENGINES), null);
});

test('labelVersions uses folder names and disambiguates by platform', () => {
  const versions = [
    { dataRel: 'eXoScummVM\\KQ6\\KQ6 (CD DOS, Windows)', platform: 'pc' },
    { dataRel: 'eXoScummVM\\KQ6\\KQ6 (CD DOS, Windows)', platform: 'windows' },
    { dataRel: 'eXoScummVM\\KQ6', platform: null },
  ];
  assert.deepEqual(labelVersions(versions, 'KQ6', 'King\'s Quest VI'),
    ['KQ6 (CD DOS, Windows), DOS', 'KQ6 (CD DOS, Windows), Windows', 'King\'s Quest VI']);
});

test('labelVersions names platforms the same way as version kinds, aliases included', () => {
  const versions = [
    { dataRel: 'eXoScummVM\\FF\\cd1', platform: 'windows' },
    { dataRel: 'eXoScummVM\\FF\\cd1', platform: 'mac' },
  ];
  assert.deepEqual(labelVersions(versions, 'FF', 'Freddi Fish'), ['cd1, Windows', 'cd1, Macintosh']);
  const canonical = versions.map((v) => ({ ...v, platform: v.platform === 'mac' ? 'macintosh' : v.platform }));
  assert.deepEqual(labelVersions(canonical, 'FF', 'Freddi Fish'), ['cd1, Windows', 'cd1, Macintosh']);
});

test('classifyVersion picks the flag platform, aliases included, for a two-platform folder', () => {
  const label = 'Freddi Fish\'s One-Stop Fun Shop (Windows-Macintosh)';
  assert.equal(classifyVersion({ label, platform: 'mac' }).key, 'Macintosh');
  assert.equal(classifyVersion({ label, platform: 'win' }).key, 'Windows');
  assert.equal(flagPlatformName('FM'), 'FM Towns');
  assert.equal(flagPlatformName('unknown'), null);
  assert.equal(flagPlatformName(null), null);
});

test('defaultSound prefers standard music', () => {
  assert.equal(defaultSound({ sounds: [{ driver: 'fluidsynth' }, { driver: 'default' }] }), 'default');
  assert.equal(defaultSound({ sounds: [{ driver: 'mt32' }] }), 'mt32');
});

test('webArguments builds space-free arguments for the web shell', () => {
  const [floppy] = buildVersions(parseExoLauncher(DOTT_BAT, 'Day Of The Tentacle (Multi-Platform)'), {}, ENGINES);
  const paths = { dataPath: '/data/games/abc-0', mt32Path: '/data/mt32', soundfont: '/data/mt32/SC.sf2' };
  assert.deepEqual(webArguments(floppy, 'default', paths),
    ['--path=/data/games/abc-0', '--platform=pc', '--aspect-ratio', 'scumm:tentacle']);
  assert.deepEqual(webArguments(floppy, 'mt32', paths),
    ['--path=/data/games/abc-0', '--platform=pc', '--multi-midi', '--aspect-ratio', '--music-driver=mt32', '--extrapath=/data/mt32', 'scumm:tentacle']);

  const auto = { autoDetect: true, gameId: null, sounds: [{ driver: 'default', options: {} }] };
  assert.deepEqual(webArguments(auto, 'default', paths), ['--auto-detect', '--path=/data/games/abc-0']);
  assert.throws(() => webArguments(auto, 'default', { ...paths, dataPath: '/data/has space' }));
});
