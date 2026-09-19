import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetworkBat, multiplayerAutoexec } from '../server/lib/netbat.js';

// eXo's own network.bat for Descent, verbatim apart from the trimmed middle. The shape is the
// same in 235 of the 255 eXoDOS games set up for network play.
const DESCENT = `echo off
cls
echo.
echo Press 1 to Host a game
echo Press 2 to Join a game
echo Press 3 to Quit
echo.
echo Note: To host a game you need port 213 forwarded
echo to the host machine.
echo.
choice /C:123 /N Please Choose:

if errorlevel = 3 goto quit
if errorlevel = 2 goto join
if errorlevel = 1 goto host

:host
cls
echo.
ipxnet startserver
cls
echo.
echo An IPX Server has been started with the default port (213).
echo.
echo Other players will need your IP address to join you.
echo.
echo Use this IP for internet play:
type ExtIP.txt
echo.
echo Press a key to launch the game. Then choose the following:
echo MultiPlayer
echo Start a Network Game
echo Select Mission
echo Press ENTER to Begin after all players have joined
echo.
pause
cd DESCENT
descent -640x480
echo.
echo Thanks for playing.
echo.
pause
exit

:join
cls
echo.
echo You will need the host's IP address in order to connect to them.
echo.
askecho /N "set IP=" "+Host's IP Address? " > SetIP.bat
call setip
IPXNET CONNECT %IP%
echo.
choice /C:123 /N Please Choose:

if errorlevel = 3 goto later
if errorlevel = 2 goto join
if errorlevel = 1 goto connected

:connected
cls
echo.
echo Press a key to launch the game. Then choose the following:
echo MultiPlayer
echo Join a Network Game
echo Select Netgame
echo.
pause
cd DESCENT
descent -640x480
echo.
echo Thanks for playing.
echo.
pause
:later
exit
`;

test('Both sides of a network.bat give up their commands and their in-game steps', () => {
  const parsed = parseNetworkBat(DESCENT);
  assert.deepEqual(parsed.host.commands, ['cd DESCENT', 'descent -640x480']);
  assert.deepEqual(parsed.join.commands, ['cd DESCENT', 'descent -640x480']);
  assert.deepEqual(parsed.host.steps, [
    'MultiPlayer', 'Start a Network Game', 'Select Mission', 'Press ENTER to Begin after all players have joined',
  ]);
  assert.deepEqual(parsed.join.steps, ['MultiPlayer', 'Join a Network Game', 'Select Netgame']);
});

test('The DOSBox plumbing and the desktop-only advice are left behind', () => {
  const { host, join } = parseNetworkBat(DESCENT);
  const everything = [...host.commands, ...host.steps, ...join.commands, ...join.steps].join('\n');
  assert.doesNotMatch(everything, /ipxnet/i, 'js-dos makes the connection, not the batch file');
  assert.doesNotMatch(everything, /askecho|setip|ExtIP/i);
  assert.doesNotMatch(everything, /IP address|port \(213\)|forwarded/i);
  assert.doesNotMatch(everything, /Thanks for playing|Press a key to launch/i);
});

test('A step that names IPX as part of the game\'s own menus survives', () => {
  const bat = DESCENT.replace('echo Start a Network Game', 'echo Select IPX Network and press Connect');
  assert.ok(parseNetworkBat(bat).host.steps.includes('Select IPX Network and press Connect'));
});

test('A file that isn\'t one of eXo\'s reads as null rather than being guessed at', () => {
  assert.equal(parseNetworkBat(''), null);
  assert.equal(parseNetworkBat(null), null);
  assert.equal(parseNetworkBat('echo hello\nexit'), null, 'no IPX at all');
  // A serial-link game: real multiplayer, but not over IPX, so not ours to start.
  assert.equal(parseNetworkBat('serial1 nullmodem port:5000\nwordtris'), null);
  // The host side is there but the game is never launched on the joining side.
  assert.equal(parseNetworkBat(DESCENT.replace(/:connected[\s\S]*$/, ':connected\ncls\nexit\n')), null);
});

test('The multiplayer autoexec keeps eXo\'s set-up and swaps the launch', () => {
  // Descent's, which is the usual shape: 251 of the 253 games with IPX on close with `exit`.
  const autoexec = ['mount c ./Descent', 'imgmount d ./Descent/cd/Descent.iso -t cdrom', 'c:', '@cls', '@call run', 'exit'];
  const lines = multiplayerAutoexec(autoexec, ['descent -nomusic']);
  assert.deepEqual(lines, ['mount c ./Descent', 'imgmount d ./Descent/cd/Descent.iso -t cdrom', 'c:', '@cls',
    '@echo.', '@echo Press a key when everyone has joined.', '@pause', '@cls', 'descent -nomusic', 'exit']);
  assert.ok(!lines.includes('@call run'), 'the single-player launch is gone');
});

test('eXo\'s exit closes DOSBox after the game, not before it starts', () => {
  // The bug this guards: `exit` left where eXo put it quit DOSBox at the mount, so the game
  // never ran at all for nearly every game offered.
  const lines = multiplayerAutoexec(['mount c ./X', 'c:', '@call run', 'exit'], ['game']);
  assert.equal(lines.at(-1), 'exit', 'the sign-off is last');
  assert.ok(lines.indexOf('game') < lines.lastIndexOf('exit'), 'the game starts before DOSBox closes');
  assert.equal(lines.filter((l) => /^@?exit$/i.test(l)).length, 1, 'and it isn\'t duplicated');
});

test('A game whose autoexec has no exit is left without one', () => {
  // DOOM and Radix are the two that end on @cls instead.
  const lines = multiplayerAutoexec(['cls', 'mount c ./DOOM', 'c:', '@cls', 'call run'], ['doomatic']);
  assert.equal(lines.at(-1), 'doomatic');
  assert.ok(!lines.some((l) => /^@?exit$/i.test(l)), 'nothing invented that eXo didn\'t have');
});

test('The autoexec waits, because js-dos brings IPX up as the game starts', () => {
  const lines = multiplayerAutoexec(['mount c ./X', 'c:', 'run'], ['game']);
  const pause = lines.indexOf('@pause');
  assert.ok(pause > 0 && pause < lines.indexOf('game'), 'the game launches after the wait');
  assert.ok(!lines.includes('run'), 'a bare run.bat call counts as the launch too');
});

test('A wait message can\'t smuggle shell characters into the autoexec', () => {
  const lines = multiplayerAutoexec(['c:'], ['game'], { waitFor: 'Ready? > x & del *.*' });
  assert.deepEqual(lines.filter((l) => /^@echo /.test(l)), ['@echo Ready? x del *.*']);
});
