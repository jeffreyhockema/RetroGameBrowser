# Retro Game Browser guide

Everything about running, configuring and using Retro Game Browser, and how it works. For what it
is and how to get started, see the [README](../README.md).

It was built for, and tested against, a LaunchBox library with the eXo collections; the figures
here (how many games play, how big they are) come from that testing and from eXo's releases.

- [Run it](#run-it)
  - [Installing on another PC](#installing-on-another-pc)
  - [Logs](#logs)
- [Playing in the browser](#playing-in-the-browser)
  - [ScummVM](#scummvm)
  - [MS-DOS](#ms-dos)
  - [Windows 3.x](#windows-3x)
  - [Windows 95 and 98](#windows-95-and-98)
  - [Consoles and the Commodore 64](#consoles-and-the-commodore-64)
  - [Arcade](#arcade)
  - [Apple IIGS](#apple-iigs)
  - [Playing with a friend](#playing-with-a-friend)
  - [A DOS game over its own LAN](#a-dos-game-over-its-own-lan)
- [Taking a game with you](#taking-a-game-with-you)
  - [How a folder plays with no server](#how-a-folder-plays-with-no-server)
- [Settings](#settings)
- [Versions](#versions)
- [Configure](#configure)
  - [Signing in with Google](#signing-in-with-google)
  - [Local accounts](#local-accounts)
  - [Admin page](#admin-page)
  - [Reaching it from anywhere: Cloudflare Tunnel](#reaching-it-from-anywhere-cloudflare-tunnel)
- [Using it](#using-it)
- [How it works](#how-it-works)

## Run it

Needs Windows (where LaunchBox runs) and [Node.js](https://nodejs.org) 22.2 or newer.

```sh
npm install             # also brings in js-dos, the browser build of DOSBox used for MS-DOS games
npm run fetch-scummvm   # one-time: downloads the browser build of ScummVM (~460 MB) into vendor/
npm run fetch-emulators # one-time: downloads EmulatorJS and its console cores (~45 MB) into vendor/
npm run fetch-mame      # one-time: downloads the browser build of MAME 0.244 for arcade games into vendor/
npm start               # http://localhost:3000
npm run dev             # restarts when server files change
npm run setup           # goes through the setup page again (see below)
npm test
```

The server answers straight away and the app shows the library once it has loaded: a few
seconds normally, a minute or more right after the PC starts, while LaunchBox's image folders
aren't in the disk cache yet.

Without a `config.local.json`, and with no LaunchBox where LaunchBox installs itself
(`C:\Users\<you>\LaunchBox`, the default `launchboxRoot`), the
server starts with the **setup page** instead (below).

### Installing on another PC

`npm run package` builds `dist\installer\RetroGameBrowser-Setup-<version>.exe`, a Windows
installer with everything in it: the app, the browser emulators, a Node.js of its own, and
[WinSW](https://github.com/winsw/winsw), which runs it as a Windows service that starts with the
PC. Building needs the emulators fetched (the three `fetch-` commands above) and Inno Setup 6
(`winget install JRSoftware.InnoSetup`); the first build downloads Node.js and WinSW into
`installer\.cache`. The files are in [installer/](../installer/).

[installer/README.md](../installer/README.md) is the plain-language readme for people who
install it: the installed copy's `README.md`, and the text to publish with an installer release
(`gh release create v<version> dist/installer/RetroGameBrowser-Setup-<version>.exe --notes-file installer/README.md`).

On the other PC the installer:

- puts the app in `C:\Program Files\RetroGameBrowser` (read-only from then on) and what it writes
  (its config, accounts, favorites, cache and logs) in `C:\ProgramData\RetroGameBrowser`, which
  only administrators and the service can open;
- registers the **Retro Game Browser** service, running as `NT AUTHORITY\LocalService`, and lets
  it through Windows Firewall on private networks (port 6502; a copy run from the project folder uses 3000);
- opens `http://localhost:6502`, the setup page.

The **setup page** answers on that PC only (`localhost`), until it's finished:

1. **Your LaunchBox folder**: it looks in the usual places (`LaunchBox` and `Documents\LaunchBox`
   in each user's folder, and `LaunchBox`, `Games\LaunchBox` and `Emulation\LaunchBox` on every
   drive), checks the folder and lists the platforms it found.
2. **Who can open it**: every device on the home network, or only this PC (with a tunnel).
3. **Signing in**: [Google](#signing-in-with-google) (client ID, your address as the owner, and
   the tunnel's address if there is one), [local accounts](#local-accounts) (with the owner's own
   account, when there's no Google), both or neither.

**Finish setup** writes `config.local.json`, and the site starts at the same address. The
LaunchBox folder can be changed later on the admin page's Server tab.

The service's account can't read a LaunchBox inside someone's user folder, where LaunchBox
installs itself, or on a network share. The setup page says so when that happens. Start menu →
Retro Game Browser → **Run the service as a Windows account** asks for an account that can read
it, and its password. A mapped drive letter (`X:`) belongs to the signed-in session, and a service
never sees it: give the setup page the network path (`\\server\share\LaunchBox`) instead.

Also in the Start menu: **Repair the service** (the install step again, in a window that stays
open) and Uninstall, which asks whether to delete the data folder as well. Installing a newer
version over an old one keeps the data and the service's account. Locked out of the owner's
local account: from a command prompt opened as administrator, `"C:\Program Files\RetroGameBrowser\service\local-account.cmd" password <username>`
(or `list`, or `off`).

### Logs

Everything the server prints also goes to `logs\server-YYYY-MM-DD.log` (in the project folder, or
`C:\ProgramData\RetroGameBrowser\logs` for an installed copy): each line stamped with the time, and
marked `err` for warnings, errors and crashes. There's a file a day, kept 30 days; a day past
20 MB goes on in `-2`, `-3`… The admin page's Server tab shows the latest 500 lines, or only the
warnings and errors. An installed copy also keeps `logs\install-*.log` from each install, and
`logs\service\`, which holds what the last run printed, for a server that failed before its own
log started.

## Playing in the browser

Every game page has **Play** for the game's default version and a **Versions** table with the
rest. Which version is the default follows a fixed ranking (see [Versions](#versions)).

### ScummVM

ScummVM games run through a WebAssembly build of ScummVM. `npm run fetch-scummvm` downloads the
engine and its data from the unofficial demo by the port's author (scummvm.kuendig.io). It takes
only the engine, not the demo's page or its error reporting. The plan is to replace this with our
own build of ScummVM later.

The download is pinned: each file's SHA-256 is checked against the build this was tested with,
so a newer build on the site is refused. `npm run fetch-scummvm -- --update` accepts the site's
current build instead and prints its new pins to paste into
[scripts/fetch-scummvm-web.mjs](../scripts/fetch-scummvm-web.mjs).

- Each game page offers every version from the eXo launcher (floppy, CD, Mac…),
  with its music choices (standard, Roland MT-32, Roland Sound Canvas, PCjr…).
- The server presents each version's eXo folder to ScummVM at `/data/games/<version>/`, plus
  eXo's MT-32 ROMs and soundfont. Files load in pieces as the game needs them.
- Saved games and ScummVM settings live in the browser's own storage (IndexedDB) for this site,
  so they're per browser and per device. Saves from the eXo (Windows) ScummVM aren't shared.
- eXo's launchers use bare game IDs (`tentacle`), which current ScummVM rejects. The server
  qualifies them (`scumm:tentacle`) using [server/data/scummvm-engines.json](../server/data/scummvm-engines.json),
  generated by `node scripts/build-engine-map.mjs` from the ScummVM builds that ship with eXo.
  IDs that can't be qualified fall back to auto-detection.

- The browser build of ScummVM plays CD music stored as Ogg Vorbis, but not FLAC. The page of
  a version whose CD tracks are FLAC only (The 7th Guest CD, for one) says it will play without music.

Known issues: some engines crash in the downloaded browser build. The engine traps
(`RuntimeError: unreachable`) when it resumes after an asynchronous wait, then its main loop is dead.
The player page detects this, stops the flood of follow-on errors and says what happened.
Engines and games known to crash are listed in
[server/data/web-known-issues.json](../server/data/web-known-issues.json); their game pages show a
warning with a **Try anyway** button. The fix is our own ScummVM build.

### MS-DOS

MS-DOS games run through [js-dos](https://js-dos.com) (DOSBox and DOSBox-X compiled to WebAssembly),
installed from npm as a dependency; nothing to fetch.

- eXoDOS keeps each game as a zip next to a small launcher folder with a `dosbox.conf`.
  Play loads the whole zip into the browser's memory and starts DOSBox with that conf,
  rewritten for the browser ([server/lib/dosbox.js](../server/lib/dosbox.js)): host paths point
  into the unpacked zip, the host window settings go, and the MIDI device is set per the music choice.
  Games with more than one conf (Tandy, CGA, … variants) get one version per conf.
- Games over `dosMaxBundleMB` (700 MB by default) are marked as not playable in the browser (and
  hidden from the shelf, see [Settings](#settings)): the zip and its unpacked files both have to fit
  in the emulator's 2 GB.
- Games run in js-dos's **DOSBox-X** build (`dosBackend` in the config). Its plain DOSBox build is
  smaller but crashed on some games and left old frames under new ones in testing.
- **Music**: "Standard" plays a game's AdLib/Sound Blaster sound with no MIDI device. Games eXo set
  up for MIDI also offer **Roland MT-32** and **Roland Sound Canvas**, which put eXo's MT-32 ROMs or
  soundfont (47 MB, cached by the browser) in the emulated file system for DOSBox-X's synthesizers.
- Some zips list a folder before any file in its parent folder, which js-dos can't unpack; the
  server spots those and the player creates the parents first (as an empty `.keep` file).
- The game's own save files are kept in the browser (IndexedDB) per version: they're stored
  when you leave with **Leave game** or the browser's Back button, every 90 s, when the tab is
  hidden and, with DOSBox-X (the default), when the game quits. Under the plain DOSBox build a quit
  keeps only what the last 90-s or tab-hidden save stored. The files are put back the next time the
  version starts. The app warns when they can't be read or stored; after a failed read nothing is
  stored that session, so the earlier saves are never overwritten. Saves from eXo's own DOSBox aren't shared.
- A game that ends within seconds of starting (its start-up commands failed) stays on the player
  with the reason instead of going back to its page.
- eXo's launcher menus in `exception.bat` (for instance "DOSBox or ScummVM?") aren't offered;
  the game starts with its main conf. Menus inside the game's own `run.bat` work as they would in DOSBox.
- The mouse moves freely over the game, and games with their own pointer follow it. Games that
  steer with the mouse (flight, 3D) need it locked: **Lock mouse** in the player bar keeps the
  pointer in the game after the next click, and **Esc** lets it go. Games whose eXo conf asks for
  a locked mouse (`autolock=true`) start with it on.

### Windows 3.x

Windows 3.1 games run in the same js-dos DOSBox-X as the DOS games: each game folder holds its
own copy of Windows, which boots to the game.

- eXoWin3x doesn't zip its games. Every game is already installed in
  `eXo\eXoWin3x\<GameDir>\`, with Windows 3.1, the S3 display driver and Sound Blaster 16
  drivers inside it, next to the same kind of launcher folder as eXoDOS
  (`!win3x\<GameDir>\dosbox.conf`).
- The first time you play one, the server copies that folder into `cache/roms/` and sends the
  browser an uncompressed zip of the copy. The page says "Copying the game on the server" while
  that happens (a minute or so for a CD game, because the games drive is slow); later starts skip
  it. The copy is trimmed from the cache like an unpacked CD game, longest unplayed first.
- The copy leaves out `WIN386.SWP`, the swap file Windows left in eXo's installs (6.5 GB across
  the collection); Windows makes its own when it starts. Nothing under LaunchBox is touched.
- Games over `win3xMaxBundleMB` (1200 MB by default) are marked as not playable in the browser.
  The browser holds the whole download and the emulator's copy of it: a 1.5 GB game started in
  testing, and a download over about 2 GB fails outright. The limit leaves 855 of eXoWin3x's 937
  games; 49 are too big.
- 33 of eXo's installs are empty (the files are there with nothing in them, so eXo's install never
  finished). Their pages say so instead of offering Play.
- The mouse starts locked to the game, because Windows draws its own pointer: click once to hand
  the mouse over, **Esc** to get it back, and **Unlock mouse** in the player bar to keep it.
- Saved games, and anything else Windows writes, are kept in the browser like a DOS game's saves.
- Known limits: a game on more than one CD can't swap discs (63 games), and games set to a fixed
  high CPU speed may run slowly on a weaker PC.

### Windows 95 and 98

eXoWin9x games run in the same js-dos DOSBox-X, which boots eXo's own copy of Windows 98 and
starts the game the way eXo's launcher does ([server/lib/win9x.js](../server/lib/win9x.js)).

- eXo builds these differently. Every game starts one shared Windows 98 disk
  (`eXo\emulators\dosbox\x98\parent\W98-C.vhd`, ~400 MB, or a network-ready or Japanese variant).
  The game is a zip in `eXo\eXoWin9x\<year>\` holding its own small disk (drive D:, with the
  shortcut and registry entries that Windows' start-up script copies in and runs) and its CD
  images, or a zip mounted as drive E:. `!win9x\<year>\<GameDir>\Play.conf` mounts them and boots.
- Those disks are too big to load into the browser, so the emulator reads them from the server a
  256 KB piece at a time as it needs them (js-dos "sockdrives", [server/lib/vhd.js](../server/lib/vhd.js)).
  Pieces that are all zeros are never sent. The Windows disk has one address for every game, so
  the browser keeps the pieces it has read and later games boot faster. Only the CD images and
  zips are loaded into memory.
- The first time you play one, the server unpacks its zip into `cache/roms/` ("Unpacking it on
  the server"). The game's disk is read from there; nothing under LaunchBox is written.
- Windows boots to the game in 30–90 seconds on a desktop PC, the first boot in a browser being the
  slowest.
- The browser's DOSBox-X can't show more than 800x600: js-dos builds it that way to save memory.
  eXo's Windows is set to 1024x768, which would leave it in 16 colours, where DirectX games refuse
  to start. So the server hands out the Windows disk with that one registry setting reading
  800x600 (the file itself is untouched). Games still pick their own screen mode.
- The conf is eXo's. Windows knows its Plug and Play devices by the numbers the BIOS hands out in
  order, so a device that's missing moves every later one along: Windows then finds "new
  hardware", asks to restart and loses the CD drive. So only what the browser's DOSBox-X lacks is
  swapped, for something that takes its place: the printer port (it has no printer) is a Disney
  Sound Source, the network card is connected to nothing, and MMX is `jsdos_pentium_mmx`.
- CD images come with their tracks named the way the cue sheet spells them: the browser's file
  system minds case, and 50 games' cue sheets say `GAME.BIN` for `game.bin`.
- Saves: Windows' disk starts as eXo made it every time, as in eXo; changes to the game's own disk
  (its saves and settings) are kept in the browser you play in, like a DOS game's.
- Games whose CD images and zips come to more than `win9xMaxBundleMB` (1200 MB) are marked as not
  playable in the browser: 44 of them, mostly two-CD games. 29 games run in 86Box rather than
  DOSBox-X, which the browser can't run; they're marked the same way (and hidden with the other
  games that don't run in the browser), and their zips can still be downloaded. That leaves 573
  of eXoWin9x's 647 games.
- Rough edges: a game on more than one CD probably can't swap discs, as with Windows 3.x; the
  network-ready Windows (67 games) tries to dial eXo's IPX server and says after a minute that it
  couldn't, which only needs OK; four games that copy settings into Windows before it boots go
  without them; the Japanese and Chinese Windows disks haven't been tried.
- There's no offline copy of these games, since they start from eXo's Windows disk on the server.
  **Game files only** downloads the game's eXo zip.

### Consoles and the Commodore 64

Console games run through [EmulatorJS](https://emulatorjs.org): RetroArch's emulator cores
compiled to WebAssembly. `npm run fetch-emulators` downloads EmulatorJS and one core per system
from the npm registry (checked against the registry's hashes) into `vendor/emulatorjs/`.

| Platform | Core | With a friend |
|---|---|---|
| Nintendo Entertainment System | FCEUmm | rollback |
| Super Nintendo Entertainment System | Snes9x | rollback |
| Nintendo 64 | Mupen64Plus-Next | by video |
| Sega Genesis | Genesis Plus GX | rollback |
| Sega CD | Genesis Plus GX | by video |
| Sega Saturn | Yabause | by video |
| Sega 32X | PicoDrive | rollback |
| Sony Playstation | PCSX-ReARMed | by video |
| NEC TurboGrafx-16 | Mednafen PCE | rollback |
| SNK Neo Geo AES | FinalBurn Neo | rollback |
| Atari 2600, 5200, 7800 | Stella, a5200, ProSystem | rollback |
| Atari Jaguar | Virtual Jaguar | by video |
| Commodore 64 | VICE | rollback |

The last column is how a game is played with a friend (see [Playing with a
friend](#playing-with-a-friend)): by rollback, everyone runs the game in step; by video, the
host runs it and streams it, with the delay that brings. DOS games are played with a friend
too, but over the LAN protocol the games themselves were written for (see [A DOS game over its
own LAN](#a-dos-game-over-its-own-lan)).

Each ran games in testing ([server/lib/emulatorjs.js](../server/lib/emulatorjs.js) has the
list). Dreamcast (no browser core) and Amiga (LaunchBox's Amiga games are usually WHDLoad installs,
which the browser core can't start as they are) aren't played here yet; add them to `platforms` in the
config to browse them. Arcade games and the Apple IIGS have their own sections below.

- A game's ROM and its other regional releases (LaunchBox's "Play (Japan) Version…" entries) are
  its versions. They're named from the ROM's file name with its tags made readable ("USA, Rev 1",
  "Europe, 5 languages", "Unlicensed"); a release sold under another title leads with it
  ("Probotector II (Europe)" for Contra). They're ranked by region: USA, World, Europe, fan
  translations, Japan, other regions, then betas, demos and prototypes.
- A game whose every release is Japan-only or another region's, with no USA, World, European or
  fan-translated version, is taken as never having come out in English, and is off the shelf
  unless the profile menu says otherwise. Games that are only a beta, demo or
  prototype are hidden by their own setting.
- Commodore 64 disks made for the Commodore 128 are marked as not working (the core is a C64),
  so a game that also has a C64 release plays that one.
- BIOS files come from RetroArch's `system` folder, found through `Data\Emulators.xml`: the Sega
  CD BIOS for the game's region and the PlayStation BIOS. The Neo Geo BIOS set comes from the Neo
  Geo ROM folder. A Saturn BIOS (`saturn_bios.bin`) is used when it's there; without one,
  Yabause starts games with its own stand-in. Nothing is copied; the server sends the file to
  the browser when a game starts.
- CD games (PlayStation, Sega CD) are .7z archives of a few hundred MB, and Saturn games zips of
  about the same size. Unpacking one in the browser takes up to a minute, every time, and holds
  the archive and its tracks in memory together. Instead the server unpacks it once with LaunchBox's own
  7-Zip (`ThirdParty\7-Zip\7z.exe`) into `cache/roms/` and sends the files as an uncompressed zip,
  which starts in seconds. The first start of such a game says "Unpacking the game on the server…"
  for 10–15 s. The cache is kept under `romCacheMB` (20 GB), dropping the games played longest ago.
- In-game saves (battery saves, memory cards) stay in the browser's storage, in a folder per
  core, so the same title on two consoles never shares a save. They're stored every minute, when
  the page is hidden, and when you leave with **Leave game** or the browser's Back button.
- The discs of a multi-disc game (Final Fantasy VII) are separate versions that share one memory
  card, so a save made on disc 1 is there on disc 2. This holds for CD games the server unpacks;
  archives under `romUnpackMinMB` are unpacked by the browser and keep a card per disc.
- Save states made with **Save State** in EmulatorJS's menu are kept in the browser (per game and
  platform). The quick-save keys (**1** saves, **2** loads, **3** changes the slot) keep a state
  only until you leave the game.
- EmulatorJS's own bar has save states, the controls, full screen and the core's settings: move
  the mouse over the bottom of the game (on a phone, tap the ☰ button). Default keys: arrows
  move, **Z** and **X** are the main buttons, **A** and **S** the other two, **Enter** is Start,
  **V** is Select, **Q** and **E** the shoulder buttons. Gamepads work too, and phones get an
  on-screen pad laid out for the console.
- On the **Commodore 64** the keyboard types on the C64 (text adventures, "press F1", RUN/STOP), so
  the arrows and Z/X don't steer; play joystick games with a gamepad, or turn off "Direct Keyboard
  Input" in EmulatorJS's settings.
- **Neo Geo** games start as the home console (AES), so **Enter** (Start) begins a game without
  inserting coins, and the options menus are the console's. The core's settings can switch it back
  to arcade mode.
- Before a CD game has been unpacked on the server, its page shows the archive's size, marked
  "packed". The unpacked size shows after the first start.
- The browser console may log "File CRC differs from ZIP CRC" when a CD game starts. The files the
  server hands over are intact (their checksums match the originals), and the game runs normally;
  the message can be ignored.

### Arcade

Arcade games run in **MAME 0.244**, the same MAME LaunchBox starts them with, compiled to
WebAssembly from MAME's own `mame0244` source. The ROM and CHD set was made for that version, so
it loads as it is: a newer MAME would reject the sets it renamed or re-dumped since.

- A whole MAME is too big for a browser, so it's built in 12 bundles of drivers
  ([server/data/mame-bundles.json](../server/data/mame-bundles.json)), and a game loads the one its
  hardware is in (21–36 MB), kept by the browser after the first time. Capcom's
  CPS1/2/3 and the Neo Geo have bundles of their own; the other 725 driver files LaunchBox's
  arcade games use are split alphabetically. The builds are made by a GitHub Actions workflow in
  [jeffreyhockema/mame-wasm-build](https://github.com/jeffreyhockema/mame-wasm-build) and published
  as a release, which `npm run fetch-mame` downloads (checksums checked) into `vendor/mame/`.
- Which games are arcade games comes from LaunchBox: a game whose emulator (in
  `Data\Emulators.xml`) starts `mame.exe`. Its ROM and its "Play … Version" entries (the set's
  clones) are its versions, named from MAME's description of each set ("World 920513") and ranked
  by the region it names, like console releases.
- What a set loads besides its own zip comes from MAME 0.244's list of sets
  ([server/data/mame0244.json](../server/data/mame0244.json), made by `npm run build-mame-data`
  from LaunchBox's `mame.exe -listxml`): a clone's parent, BIOS sets (`neogeo.zip`, `pgm.zip`), devices with ROMs
  of their own (`qsound_hle.zip` for CPS2), disk images (a clone's shared CHD comes from its
  parent's folder) and samples (from MAME's `samples` folder). A set missing any of those is
  marked with what's missing. The collection is a split set, so a clone also loads its parent's
  zip (a clone's own has only the ROMs that differ).
- Everything is loaded into the browser's memory before MAME starts, so games bigger than
  `mameMaxGameMB` (1024) are marked too big: the laserdisc games (Cliff Hanger, M.A.C.H. 3,
  11–14 GB) and some hard disk games (CarnEvil, Gauntlet Dark Legacy, Area 51 / Maximum Force Duo).
- The picture keeps the monitor's shape: 4:3, or 3:4 for a game whose monitor stood on its side.
- Keys are MAME's own: **5** inserts a coin, **1** starts, arrows move, **Left Ctrl**, **Left Alt**,
  **Space** and **Left Shift** are buttons 1–4 (**Z**, **X** 5–6); player 2 is **6**/**2**, R/D/F/G
  to move, **A**, **S**, **Q**, **W** for buttons. **Tab** opens MAME's menu (controls, DIP
  switches, cheats), **F7** loads and **Shift+F7** saves a state, **P** pauses. **Esc** asks
  before quitting.
- Gamepads work for up to four players: **Select** inserts a coin, **Start** starts, the D-pad
  or left stick moves; the face buttons are buttons 1–4 bottom, right, left, top, and the
  shoulders 5–6.
- MAME's settings (controls changed in its menu), the game's NVRAM (high scores, operator
  settings) and save states stay in the browser's storage, one store per set. Save states reach
  it every minute and when the page is hidden; NVRAM is written as MAME stops, when you leave
  with **Leave game**.
- On a phone, an arcade game gets on-screen buttons like a DOS game's: the d-pad is the joystick,
  the round buttons are buttons 1–4 and the shoulders 5–6 (only as many as the game has), and the
  middle buttons are **Coin** and **Start**. The bar's **Buttons** sheet changes what each one
  presses, with MAME's own keys listed first. On a phone held upright the game sits at the top
  with the buttons below it.
- **Download → Offline copy** packs an arcade game with its bundle of MAME (about 30 MB on top
  of the game) and plays from the folder like any other download, keeping its high scores and
  save states in the browser.
- Light gun games aim where the pointer is: a click, or a tap on a phone, shoots there (the
  build's pointer light gun, patch 0002 in the build repository). The screen is sized to the
  game's monitor so the pointer and the gun agree; a game's own gun calibration (in its service
  menu) can still be a little off. The right mouse button is the gun's second button.
- **Play with a friend** works as it does for the consoles (see [Playing with a
  friend](#playing-with-a-friend)): by **rollback** where two copies of MAME are known to stay in
  step, so friends play as players 2–4 with the game feeling local, and **by video** otherwise,
  the host's game streamed and friends' presses sent back. In testing, 1,392 of 2,608 arcade
  games played in step; the rest stream. Which a game gets is in
  [server/data/mame-netplay.json](../server/data/mame-netplay.json), worked out in two passes in the
  browser. First, one game of each of MAME's 505 arcade drivers was put through saving, loading
  and replaying, and weighed: the state small enough to keep two dozen of, a frame with its save
  and load leaving room to re-run a few inside one 60th of a second. Then every game that had
  come through — 1,423 of them — was asked the question that actually decides it: go back three
  frames and run them again, and do they come out exactly as they played the first time? 1,362
  do. The other 61 don't, and they stream, because a copy that rolled back would no longer be
  playing the same game as one that hadn't. Three kinds of game never even get that far: one
  played with a wheel, paddle, trackball, spinner or gun (that control is read from the player's
  own pointer, which the other copies never see), one MAME can't save the state of at all, and
  one whose two runs came apart on their own.
- Players 2–4 on one keyboard: coin **6**/**7**/**8**, start **2**/**3**/**4**; player 2 moves with
  R/D/F/G and has buttons A S Q W E Y, player 3 moves with I/J/K/L and has B N M O U H, player 4
  moves with the keypad's 8/4/2/6 and has keypad 7 9 1 3 0 and its decimal point.
- Trackball and spinner games get only what the keyboard and a gamepad can do. The big 3D boards
  of the late '90s (Namco System 12, ZN, ST-V, Midway's hard-disk games) may run slowly; the 2D
  boards run at full speed on a desktop.

### Apple IIGS

eXo's Apple IIGS collection (eXoAppleIIGS, 460 games) runs in MAME 0.244's Apple IIgs, in a
bundle of its own built like the arcade ones. eXo starts these games in GSplus, so each game's
GSplus setup is turned into MAME's ([server/lib/iigs.js](../server/lib/iigs.js)).

- A game's launcher (`!appleiigs\<game>\<game>.bat`) and its `config.txt` say which disks go in
  which drive and which ROM the machine has. ROM 01 games start MAME's `apple2gsr1`, ROM 03
  games `apple2gs`, with 8 MB of memory. Hard disk images go on a CFFA2 card in slot 7, 3.5"
  disks in the slot 5 drives, 5.25" disks in slot 6. A game with a menu of setups (eXo's
  `exception.bat`) gets one version per setup.
- The ROMs come from the arcade ROM folder, or from eXo's own `emulators\MAME\roms`. The disks are
  read out of the game's zip as MAME asks for them; nothing is unpacked on the server.
- A game's battery RAM (GSplus's `bram` settings: the startup slot, the control panel) is put
  into MAME's before the first start, so a game that boots from its hard disk does.
- What a game writes to its disks stays in the browser's storage, per game and version, as do
  MAME's NVRAM and settings.
- The keyboard is the IIgs's, whole, and a click on the game gives it the mouse. On a phone, the
  bar's **Keyboard** button brings up the phone's own keyboard to type with, and the on-screen
  buttons press keys as a DOS game's do (arrows, Ctrl, Alt, Space, Shift, Tab, Return), changed
  in the **Buttons** sheet.
- What eXo tells the player before a game starts (its `exception.bat`: "double click Start",
  "when asked for disk 2, just press Return") is shown as **How to play** on the game's page and
  for a while as the game starts: 54 games have some. Where eXo's advice is about GSplus (its F4
  disk menu) or its own setup of it, [server/data/iigs-notes.json](../server/data/iigs-notes.json)
  says it the MAME way instead.
- The game's other floppies, the ones no drive starts with (a Disk 2 asked for later, data
  disks), are loaded too, for **MAME's File Manager** to swap in: press **Scroll Lock** (the
  keyboard is the IIgs's until then), **Tab**, choose File Manager, then the drive and the disk.
  **Scroll Lock** again gives the keyboard back to the game.
- Every game was started in testing. Eight are marked as not working, with why
  ([server/data/iigs-known-issues.json](../server/data/iigs-known-issues.json)): Great Western
  Shootout crashes the browser's MAME, Balance of Power's disk lacks a system tool it needs, and
  six (Columns, Boggled, Hammurabi, DungeonGS, Missile Attack, Questmaster) load their system and
  then stop at an empty screen, still there after five minutes. Some games take minutes to
  get going (Magical Myths says "Please wait" for over two), and many wait for a key.
- **Play with a friend** is **by video**: the host's game is streamed, and a friend's keyboard and
  mouse go to it, as if both sat at the one computer. Rollback can't work here: a IIgs's state is
  almost 9 MB, and what a game writes to its disks isn't in it.

### Playing with a friend

A console, arcade or Apple IIGS game's page has **Play with a friend** next to Favorite. It starts the game as Play
would and copies an invite link (also under **Invite link** in the player's bar, with Copy and,
on a phone, Share). Whoever opens the link sees the game's page, types a name, presses **Join as
player 2**, and their browser loads the same game and joins yours: their keyboard, controller
or, on a phone, EmulatorJS's on-screen pad work player 2's controller. Up to three friends can
join, as players 2, 3 and 4; the bar and the invite sheet say who's in. Leaving the game ends it
for them.

The link is made at the address set under **Invite links** on the admin page's Server tab (the
tunnel's, say, which must be in `allowedHosts`). Without one it uses the address the game was
started at, which a friend elsewhere can't open when that's `localhost` or a local network address.

- This is EmulatorJS's own netplay, which it marks experimental, with its frame sync replaced
  (see below). Every player runs the game. When someone joins, the host's game sends its save
  state and everyone loads it, and frames are counted from there. From then on the games are
  kept together by **rollback**, as GGPO's and today's fighting games' is (`netplay` in `CORES`,
  [server/lib/emulatorjs.js](../server/lib/emulatorjs.js), says which consoles that works for).
  Every player stamps each of their own presses with the frame it takes effect on, two frames
  ahead, and sends it to everyone else; nobody waits for anyone. A player runs on assuming the
  others press nothing new, and when a press turns out to belong to a frame already run, the
  emulator is put back to the state it saved after that frame, the press applied, and the
  frames since re-run, all within a few milliseconds (about 1 ms a frame for these cores; two
  or three frames at a time on a typical link). Your own presses take effect after two frames
  whatever the ping, about 45 ms from press to screen; a friend's presses show up half a ping
  late and get corrected. A player only ever runs eight frames past what everyone has
  confirmed, so a dropped link pauses them rather than letting the games run apart. This is
  what fighting games use, and it's what makes Mario and Sonic feel local with a friend across
  the country.
- **Arcade games play by rollback too**, on the same engine: MAME is given to it as the console
  cores are ([public/player/mame-netplay.js](../public/player/mame-netplay.js)), with its state
  saved and loaded in memory and its frames run one at a time (the browser build's own
  additions, see the build repository). A few things had to be put right in MAME for two copies
  to stay in step: it polled the keyboard on a real-time clock, so a replayed frame could take a
  press a frame late; a real-time clock's date and time weren't saved, so two machines parted a
  second after a hand-over; and presses, the mouse and controllers are kept from MAME while
  playing together, so nothing reaches a game except on the frame every copy runs it (MAME's own
  menu and its shortcuts are off for the same reason). What a sound chip holds is left out of the
  check the players keep each other honest with, the chip's own parts along with it: a chip's
  state doesn't come back from a load exactly, and how far it has got depends on how fast the
  browser's speakers are eating what it makes, so the music can sit a hair out of phase on one
  screen while the game itself is identical. Some drivers won't be caught on every frame — MAME
  refuses to save one while a driver has a timer in the air, which happens on perhaps one frame
  in fifty — so a rollback lands on the nearest state kept before the frame it wants and re-runs
  a frame or two more, and a hand-over that couldn't be taken is tried again a few frames later.
  That alone brought another 69 drivers in, Mario Bros., Rainbow Islands, Dig Dug and Aliens
  among them. States are a few hundred KB for most boards, a frame costs 2–4 ms to run and keep,
  and a rollback of a couple of frames takes about 4 ms.
- A rollback re-runs the last few frames, and they have to come out the way they played the
  first time. On MAME 0.244 as it came, 776 of those 1,423 games didn't: two browsers playing
  U.N. Squadron parted on about one run in three. The sound looked guilty (its chips drift a
  little over a load) but wasn't. What a game's ports read is worked out once a frame and held
  until the next, and that latch was never written to a save state — so a machine that loaded
  one went on reading the buttons of the frame it had already reached, and a replayed frame ran
  with the wrong button held: one byte of the game's own memory, caught in Street Fighter II as a
  button bit that was up the first time and down the second. The build now writes the latch into
  the state (patch 0009 in the build repository), along with two other things 0.244 left out: the
  scheduling quanta that decide how a board's CPUs interleave (0007), and a way to press a key
  that counts on the frame it's pressed in rather than whenever the browser's event queue is next
  pumped (0008, which the player uses for every press). That brought 727 games back. The 61 that
  still come apart are mostly boards whose sound is simulated circuit by circuit (netlist and
  discrete sound, speech chips) and drift on a replay now and then; they stream.
- The Sega CD, Saturn, PlayStation, Nintendo 64 and Jaguar are played with a friend **by video**
  instead ([public/player/netplay-stream.js](../public/player/netplay-stream.js)): only the host
  runs the game, and each friend gets it as a video and audio stream over a WebRTC connection
  straight from the host's browser, sending their presses back over a data channel on the same
  connection, which the host puts into the game as that friend's controller. What the friend
  sees runs a little behind the game (encoding, the trip, decoding: some tens of milliseconds
  on a good link, more on a poor one) and their presses take the trip back, so it suits
  turn-based, puzzle, strategy and slower games and not ones that hang on split-second timing.
  **Play with a friend** says so before hosting one of these, and the join page tells the friend.
  These consoles can't be played the other way: the PlayStation, Nintendo 64 and Jaguar cores
  use recompilers and threads, so two copies can't be relied on to run alike, and the Sega CD's
  and Saturn's states are too big to save every frame. (The engine also has a **lockstep** mode, as Dolphin's
  and Kaillera's, for a deterministic core with big states; no console is offered that way,
  since every press then waits for the slowest player.)
  - An arcade game streams the same way, with the friend's presses going in as that player's
    keys in the host's MAME ([public/player/mame-netplay.js](../public/player/mame-netplay.js)).
  - The friend's page is a small viewer ([public/emu/watch.html](../public/emu/watch.html)), not
    the emulator: it needs no game files and starts in a second. Keys are EmulatorJS's defaults,
    a controller works by the browser's standard layout, and a phone gets buttons on screen.
  - The host's canvas is captured at up to 60 fps and sent no taller than 540 pixels, scaled
    by whole numbers, at up to 6 Mbps, with frame rate kept before sharpness; the core's sound
    is caught as it's made (the AudioContext RetroArch's OpenAL creates) and sent along. The
    friend's browser is asked to buffer as little as it can.
  - The stats show, for each friend, the round trip of their presses, the video's frame rate,
    bitrate and size, whether the encoder is being held back (by bandwidth or CPU), and the
    friend's own buffer; the session log records the same.
- The presses travel straight between each pair of browsers over a WebRTC data channel
  (introduced through the room's socket), so the server, the tunnel and everything between
  are out of the way. The channel never resends; instead every packet carries every press the
  other side hasn't acknowledged, so a lost packet is made good by the next. Where the two
  browsers can't find a direct path (a strict office or mobile network), the packets go
  through the room's socket instead, which works but adds the trip; the stats say which
  ("direct" or "via the server"). A TURN server in `netplay.iceServers` relays through those.
- As a safety net, every frame (every 15th for a state over 512 KB, never over 2 MB) each
  player hashes their emulator's state and sends the hash with the frame's packet, and
  everyone compares the others' against their own for the same frame. Two frames in a row that
  differ mean the games have come apart (a core that isn't deterministic, a setting that
  differs), and the host sends everyone a fresh state within a few frames; the stats count
  these as resyncs. The 8- and 16-bit cores here are deterministic and never trip it in
  testing; the Nintendo 64 and PlayStation cores use recompilers and threads and may. The
  hand-over itself is exact: a friend finds their frame 0 by hashing the first ticks after the
  load (the core takes a state in during a later iteration), and the buttons held at that
  moment come with the state, since the core keeps those outside it.
- Rollback asks one thing of the core: RetroArch paces the emulator by its audio buffer, so a
  burst of loop iterations would run only the frames it's "owed", and a replay wouldn't
  happen. In a rollback game `audio_sync = false` goes into the core's config before it starts
  (`audioSyncOff`), each loop iteration then runs exactly one frame, and the player page keeps
  time itself at the console's own frame rate (60.0988 fps for an NTSC NES, 50.007 for a PAL
  one; `frameRateFor`), letting an iteration run only when a frame is due and catching up a
  frame when the display is slower than the game. A rollback replays a few frames of sound
  too, which can be heard as a tick when a correction is big.
- A state load isn't quite a clean jump back: the core takes a loaded state in only after running
  one more frame, which is thrown away, and a trace of that frame stays in the core outside the
  state. About 1 load in 120, the next frame then comes out differently from how it went when it
  was played, and the players' games part (on a bad connection, with a few rollbacks a second,
  that was every minute or two). So a rollback first loads the state from the frame before the one
  it wants and puts in the buttons that frame ran with; the frame the real load throws away is
  then exactly the frame that came before, and in 3,000 comparisons none differed. A friend
  joining gets the host's state from the frame before too, for the same reason.
- An input can turn up while a player is stalled, and it's often what ends the stall. A rollback
  needs the core's loop running, so one that arrives then waits and runs the moment the game
  resumes (on the cellular test of 2026-09-15, rolling back while paused ran no frames and put the
  games apart every time). An input only a frame late needs no rollback at all: it goes straight
  into the core's buttons for the next frame.
- The room itself, the socket and the save-state hand-over are EmulatorJS's own, over a small
  socket.io server on this same port ([server/lib/netplay.js](../server/lib/netplay.js),
  `/api/netplay`), which speaks the protocol the vendored EmulatorJS 4.2.3 client does (there's
  no public server for it any more: the official one has since been rewritten for a newer
  client). The host's and friends' pages drive EmulatorJS's netplay functions directly, so its
  own Netplay menu stays hidden (`startNetplay` in [public/emu/play.html](../public/emu/play.html)).
- EmulatorJS's frame sync as shipped doesn't work (its source says "control syncing -
  broken"): a friend threw away the host's "nothing happened this frame" messages and so could
  only advance on frames that had a button press in them, then froze for good after asking for
  a resync once, and inputs took effect on the host at once but on friends ten frames later,
  so the games drifted apart from the first press. That part is replaced from outside, the
  way [public/player/emulatorjs-fixes.js](../public/player/emulatorjs-fixes.js) repairs other
  EmulatorJS behaviour, in [public/player/netplay-fixes.js](../public/player/netplay-fixes.js);
  its rooms, socket, messages, state hand-over and pause/play are EmulatorJS's own.
- The cores take EmulatorJS's per-frame hook (`Module.postMainLoop`, which its netplay counts
  frames with) only as they start, and EmulatorJS sets it later, once a room is joined; the
  player page passes the core a stand-in that calls whatever EmulatorJS puts there.
- A friend's browser has to fetch the game, so the link stands in for an account: while the
  room lasts, whoever opened it may fetch that one version's files (a cookie set by the join
  page; `roomGrant` in [server/index.js](../server/index.js)), and nothing else. A friend needs no
  account, and nothing they do is counted as a play.
- The link is the address the host is using: sent from the tunnel's address it works from
  anywhere; sent from `http://192.168.x.x:3000` it works on the local network only. The room's
  socket goes through the server (a WebSocket, which Cloudflare's tunnel carries) and the
  direct channels set themselves up through it, so no port needs opening.
- A friend's keys are EmulatorJS's defaults (arrows, Z/X, A/S, Enter, V, Q/E) and their own
  controller settings; the host's Controller Layout setting doesn't reach them. Only each
  player's own first controller counts during a game with friends (a second gamepad on the
  host's PC doesn't). Save states, restarts and pausing are the host's; a friend's bar loses
  them.
- Every press, the host's too, takes effect a few frames later: the delay. In rollback it's
  two frames, always, and a press is on the screen in about 45 ms however far away the other
  player is. When a message is late, the players carry on and the game corrects itself; only a
  player who has run eight frames past what everyone has confirmed waits, for as long as the
  message takes.
- How it's going is measured and shown: each player's **input lag** (the time from their own
  press to its taking effect on their screen, over the last ten seconds), the **ping** and
  whether the presses go **direct** or **via the server**, how many frames a player runs
  **behind** or **ahead** of the others, **stalls** (times a player ran out of frames, and for
  how long), the **delay**, in rollback the **rollbacks** in the last ten seconds and how many
  frames each re-ran, and any **resyncs**. A friend sees their own in their bar; the
  host's bar names each friend's lag and the invite sheet has everything for every player.
  A player's lag is the number that says how the game feels to them: much over 100 ms and a
  platformer gets hard.
- **Detailed stats** (a link on the invite sheet, a **Stats** button on a friend's bar) opens
  [/netplay-stats.html](../public/netplay-stats.html) in a window of its own: every game of the
  site open in that browser reports itself there once a second (frames, vouches, each other
  player's connection and path, presses, stalls, the engine's log), with **Copy report** for
  sharing. A window rather than a tab because a game whose tab is hidden runs at a frame a
  second (browsers throttle hidden tabs), which stalls everyone else within a few frames; the
  page says so in red when that's happening.
  It also shows the **build** the server runs (`/api/build`: the git commit, a plus when files
  are changed on top of it, and a hash of the code) and fetches the app's key files past the
  browser's cache to check each against the server's hash, so an old copy kept by a cache in
  between (Cloudflare's, in front of the tunnel) shows as stale. The server sends
  `CDN-Cache-Control: no-store` for its own files to keep that from happening.
- Every game with friends is **logged on the server** as it goes, in
  `userdata/netplay-logs/` ([server/lib/netplaylog.js](../server/lib/netplaylog.js)): a file per
  session (JSON Lines) with each player's numbers once a second (input lag, ping, transport,
  frames ahead, stalls, delay, rollbacks, divergences, frames and packets that second, whether
  their tab was hidden) and what happened (who joined and left, hand-overs, divergences, resync
  requests), then a summary. The stats page's **Sessions** section lists them (newest first,
  a live one marked) and draws one: a chart each for lag, ping and stalls or rollbacks over
  the game, one line per player, with red ticks where the games came apart and grey where a
  tab was hidden, the players' medians, and the events. The list and a session are also plain
  JSON at `/api/netplay/logs` and `/api/netplay/logs/<name>`, for accounts that may play. The
  newest 200 sessions are kept (`netplay.keepLogs`).
- Console games are played with a friend by rollback where the core runs the same on two PCs
  given the same presses and can save a state every frame, by video otherwise; the server
  decides which from the console (`netplay` in `CORES`). DOS games take a third road entirely,
  below.

### A DOS game over its own LAN

255 of the eXoDOS games were set up by eXo for network play: DOOM, Descent, Duke Nukem 3D,
Warcraft, Command & Conquer, Quake, the racing and flight sims. eXo marks them by turning
DOSBox's IPX on in the game's `dosbox.conf`, and 235 of them carry a `network.bat` next to
`run.bat` with the host/join menu eXo wrote for each. **Play with a friend** appears on those
games too, and the link works the same way.

Nothing is kept in step here, because nothing has to be: these games have their own
multiplayer, written for a 1995 office LAN, and all the browsers need is that LAN.

- js-dos 8.4 carries IPX between browsers over WebRTC data channels, so the packets go
  straight from one player's emulator to the other's. This app only introduces them. That
  introduction is the **humblepeer** protocol, which js-dos inherited from HumbleNet:
  FlatBuffers messages over a WebSocket whose subprotocol is `humblepeer`. It's spoken here,
  not by js-dos's public server ([server/lib/humblepeer.js](../server/lib/humblepeer.js) is the
  codec, [server/lib/ipx.js](../server/lib/ipx.js) the server, at `/api/ipx` on this same port).
  The host's page starts an IPX server inside its DOSBox and registers the name `host`; a
  friend's page asks for that name, gets the host's peer id, and connects to it.
- Each room has its own catalog of peers and names, so one room can't see or address another's.
  A relayed ("emulated") peer connection is refused: this server carries no game traffic.
- The one-click start comes out of eXo's `network.bat`
  ([server/lib/netbat.js](../server/lib/netbat.js)). It holds, per game, the command that starts
  that game's multiplayer mode and a few lines telling the player which of the game's own menu
  items to pick. The IP address and port forwarding it asks for are gone — js-dos makes the
  connection — so what's left is the command, which replaces `call run` in the game's autoexec,
  and the instructions, which the player page shows beside the game. 216 of the 235 files
  parse; the rest are offered without the one-click start rather than guessed at.
- The autoexec waits for a key press before launching. js-dos brings IPX up as the emulator
  starts rather than before it, so a game launched by the first line of the autoexec can miss
  the network; eXo's own file pauses at the same point, and the host wants to wait for their
  friends anyway.
- What the emulator can't do is drive a 1995 game's own network menus, so that part is the
  player's: the panel beside the game is eXo's own instructions for it ("Press ENTER to start
  Server", "MultiPlayer → Start a Network Game"). One click gets both players to the game's
  multiplayer lobby with the network already up; the last few presses are theirs.
- These sessions appear in the multiplayer stats as who was there and for how long, with no
  frames or pings: the emulators talk to each other directly, so the server never sees the game.
- Windows 3.x has one such game (CivNet) and Windows 9x is left out: the only Ethernet backend
  compiled into js-dos's DOSBox-X is a stub, so a Win9x guest has no network to reach.

## Taking a game with you

Every game page has a **Download** menu next to Favorite, for anyone who can play, with two
choices for the version Play would start, each with its size:

- **Game files only**: just the game, for an emulator of your own. A console game's ROM or disc
  archive, an arcade game's MAME zip and a DOS game's eXoDOS zip come as the collection has them; a Windows 3.x game's
  installed folder and a ScummVM game's data folder come as a zip (see
  [server/lib/gamefiles.js](../server/lib/gamefiles.js)).
- **Offline copy**: the version — and its music choice — packed into a zip that plays on its own:

```
Leisure Suit Larry 3/
  Leisure Suit Larry 3.html   <- open this
  media/                      the art, videos, manual and everything in the box
  player/                     the browser engine and the game's files
  README.txt
```

Unzip it and open the .html file. It's a copy of the game's page — art, description, facts,
videos, screenshots, box art, the manual and the extras — with a Play button that starts the
game. No server, no internet, nothing installed; it works on any machine with Chrome, Edge or
Firefox, and the files never leave the folder. Saved games are kept by the browser you play in
rather than in the folder, so a download copied to another PC starts over.

A download carries the browser build of whichever engine the game needs, so it's bigger than
the game: about 9 MB for MS-DOS and Windows 3.x, 3 MB for a console, 21–36 MB for an arcade game's
bundle of MAME, and 80–120 MB for ScummVM
(its build is 32 MB before the engine plugin and data files). The button says what the whole
folder will come to.

Size is the one thing worth watching. The button's figure is the unzipped folder, which is
larger than the download itself, and it counts the game's extras: some eXoDOS games ship a
couple of hundred megabytes of scanned manuals and guide books.

The server packs two offline copies at a time. Asking for another meanwhile waits its turn on the
game's page (it says how many are ahead), and the download starts by itself once there is one. A
download that has sent nothing for 10 minutes, paused in the browser say, gives its turn up to
someone waiting.

Two things differ from playing in the app. A page opened from a file has no origin a browser
will trust with an AudioWorklet, so js-dos falls back to the older way of playing sound; it
works, and the browser console says the node it uses is deprecated. And DOSBox-X occasionally
traps on start (twice in about a dozen runs here, under software rendering, where the app's
own player didn't) — the page says the game stopped and offers **Start it again**, which has
always worked.

### How a folder plays with no server

A page opened as a file rather than from a server may not `fetch()` anything else on disk in
Chrome or Edge, which is how all three engines normally read their WebAssembly builds and a
game's files. A plain `<script src>` is still allowed, so
[server/lib/standalone.js](../server/lib/standalone.js) writes everything the engine reads into
.js files as base64, and [public/offline/runtime.js](../public/offline/runtime.js) answers the
engine's `fetch()` and `XMLHttpRequest` calls from those. The engines are then started with
the same settings the app's own player pages use, worker and all: a worker can't be started
from a file on disk, but js-dos makes its own out of the script it fetches (which the shim
answers) and hands it the already-compiled engine, so nothing inside it reads from disk.

The zip is written straight to the response as it's put together
([server/lib/zipstream.js](../server/lib/zipstream.js)), so a game of several hundred megabytes
starts downloading right away and nothing is built on disk.

## Settings

The round button in the top-right corner is the profile menu: the account's Google picture
(or an empty figure when signed out, whose menu starts with Sign in with Google). It holds two
filters anyone can change for themselves (games without an English release, and, for players,
games that don't work in the browser), **Controllers**, **Admin** for the owner, and **Sign out**.
An account's choices are saved on the server in `userdata/settings.json` (git-ignored, or
`userdata/users/<hash>/` for accounts other than the owner's), so they apply on every device;
only where they differ from the owner's defaults, so they follow a default changed later.
Someone not signed in keeps them in the browser. Games played here are counted in
`userdata/plays.json` (see [Using it](#using-it)).

What the shelf shows everyone by default is set by the owner on the admin page's **Server** tab
(**What the shelf shows**, kept in `userdata/server.json`). All of it is off at first, so the
shelf opens on the games most people are looking for; the filters above the shelf narrow it from
there. Four switches say what the shelf may show at all, and a fifth says what counts as
multiplayer.

- **Games that never had an English release.** Console releases whose every version is Japanese
  or another region's, with no USA, World, European or fan-translated one. Computer games are
  classified by media rather than region, so this never hides one.
- **Betas, demos and prototypes.** Games whose every version is an unfinished release.
- **Games without a picture.** Games LaunchBox has no box front, 3D box or screenshot for, which
  would sit on the shelf as blank tiles.
- **Games that don't work in the browser yet.** Games where every version has a known problem: a
  ScummVM engine or game listed in
  [server/data/web-known-issues.json](../server/data/web-known-issues.json), an eXoDOS zip that's over
  `dosMaxBundleMB` or missing, a launcher that needs a helper program the browser can't run
  (sciAudio), and a console ROM that's missing or over `emulatorMaxRomMB`. Their game pages say why.
- **Count DOS and Windows games without network play as multiplayer.** Off, the Multiplayer
  shelf and the Players menu's 2+ and 3+ list only the DOS and Windows games that can be played
  with a friend over the network here. On, they also list Windows 95 games and ones where players
  take turns or share the keyboard.

## Versions

When a game comes in several versions, Play starts the best one by a fixed ranking of version
kinds: media plus platform for computer games ("CD DOS", "Floppy DOS", "CD FM Towns", "Amiga")
and the region for console games ("USA", "Europe", "Japan"). It puts the big PC releases first
and USA releases first among consoles, which is what someone playing at home in English wants.
Ties between releases of the same computer game go to the bigger one, and console releases of the
same kind keep LaunchBox's order (the game's own ROM first).

Kinds are worked out from eXo's folder names and ScummVM's `--platform` option
([server/lib/versionkind.js](../server/lib/versionkind.js)), and from No-Intro ROM names
([server/lib/emulatorjs.js](../server/lib/emulatorjs.js)). The order itself is
`DEFAULT_VERSION_ORDER` in versionkind.js.

Each game's versions table has **Set as default**, which picks the version Play starts for that
game only, overriding the ranking. That choice is a setting, so it applies on every device.

## Configure

Defaults live in [server/config.js](../server/config.js). Override them with a `config.local.json`
in the project root (git-ignored; `C:\ProgramData\RetroGameBrowser` for an installed copy, whose
service `RGB_DATA_DIR` points there; restart the service after a change), for example:

```json
{
  "launchboxRoot": "D:\\Games\\LaunchBox",
  "platforms": ["ScummVM", "MS-DOS", "Nintendo Entertainment System", "Sony Playstation"],
  "host": "127.0.0.1",
  "port": 3000,
  "dosMaxBundleMB": 700,
  "win3xMaxBundleMB": 800
}
```

- `launchboxRoot`: the LaunchBox folder (`C:\Users\<you>\LaunchBox` by default, where LaunchBox
  installs itself).
- `fallbackRoots`: other locations to try when a file can't be read under `launchboxRoot`
  (for example a collection reached through a junction that no longer resolves, whose files are
  still on another drive). None by default.
- `dosMaxBundleMB`: the biggest eXoDOS zip the browser is offered to load (700).
- `win3xMaxBundleMB`: the biggest installed Windows 3.x game the browser is offered to load.
  It counts the game's folder, which is sent uncompressed (1200).
- `win9xMaxBundleMB`: the most CD images (and mounted zips) of a Windows 95/98 game the browser
  is offered to load; its hard disks are read from the server instead (1200).
- `dosBackend`: `"dosboxX"` (default) or `"dosbox"`, the js-dos build that runs DOS games.
- `platforms`: the LaunchBox platforms to show, in the Platform menu's order (grouped under
  LaunchBox's categories). The default lists every platform the browser can play. A platform
  LaunchBox doesn't have is skipped with a warning.
- `emulatorMaxRomMB`: the biggest console ROM the browser is offered to load (1024).
- `mameMaxGameMB`: the biggest arcade game (its zips and disk images together) the browser is
  offered to load (1024).
- `sevenZipPath`, `romCacheMB`, `romUnpackMinMB`: the 7-Zip that unpacks CD games (relative to
  `launchboxRoot`), how big `cache/roms/` may grow (20000) and the smallest archive worth
  unpacking on the server (32; the browser unpacks smaller ones quickly itself). Without 7-Zip
  the browser unpacks every archive.
- `netplay.maxRooms` (100): games that may be hosted for friends at once. `netplay.iceServers`:
  the STUN servers the players' browsers use to find a direct path to each other for the
  presses (Google's public ones by default); a TURN server, for networks that allow no direct
  path, goes in the same list as `{ "urls": "turn:...", "username": "...", "credential": "..." }`.
  `netplay.keepLogs` (200): how many sessions' logs are kept. `netplay.maxIpxPeers` (8): the most
  players in one [DOS game over its own LAN](#a-dos-game-over-its-own-lan).
- `activity.keepMonths` (24): how many months of the admin page's activity log are kept.
- The settings inside `netplay` and `activity` can be set one at a time; the others keep their
  defaults. `auth` is replaced whole.
- `host`: keep `127.0.0.1` unless you want other devices on your network to browse.
- `port`: 3000 run from the project folder, 6502 for an installed copy.
- `allowedHosts`, `auth`, `localNetworkCanPlay`: see [Signing in with Google](#signing-in-with-google)
  and [Cloudflare Tunnel](#reaching-it-from-anywhere-cloudflare-tunnel).
- `cacheDir`: where thumbnails, `dos-launchers.json`, unpacked CD games, copied Windows 3.x
  games and unpacked Windows 95/98 games (`roms/`) are written (default `cache/` in the project
  root). Use an absolute path, and never point it inside the LaunchBox folders.
- `thumbCacheMB` (3000): the most the thumbnails may take up; past it the oldest are deleted and
  made again when they're next asked for.

The environment variables `LB_ROOT` (for `launchboxRoot`), `PORT` and `HOST` override both the
defaults and `config.local.json`, for example `PORT=3005 npm start`. `RGB_CONFIG` names one more JSON file, read over
`config.local.json` (a test server's, say).

### Signing in with Google

With no Google client ID in the config (and [local accounts](#local-accounts) off) there are no accounts: everyone on the local network can
play and download, and the favorites, plays and settings in `userdata/` are shared. The
[admin page](#admin-page) and the server's own settings answer only on this PC itself
(`http://localhost`), not to the rest of the network. Requests from the
internet (through a tunnel) can only browse until sign-in is set up. Add one and
the profile menu (top right) gets Sign in with Google, and shows who is signed in:

```json
{
  "auth": {
    "googleClientId": "1234567890-abc.apps.googleusercontent.com",
    "owner": "you@gmail.com",
    "players": ["friend@gmail.com"]
  },
  "allowedHosts": ["games.example.com"]
}
```

| | Not signed in | Signed in | In `players` | `owner` |
|---|---|---|---|---|
| Browse the shelf and game pages | yes | yes | yes | yes |
| Favorites of your own | | yes | yes | yes, with LaunchBox's |
| Play and download games | on the local network | on the local network | yes | yes |
| Join a friend's game from its link | yes | yes | yes | yes |
| Plays counted, Recently played | | | own | own, with LaunchBox's history |
| "Games that don't work in the browser" setting | | | yes | yes |

- `auth.owner`: the account whose LaunchBox this is. Its favorites and play history include
  LaunchBox's, and the favorites, plays and per-game defaults this app kept before there were
  accounts (`userdata/settings.json` and `plays.json`) are its own.
- `localNetworkCanPlay` (on by default): anyone on the local network (this PC, or a private
  address such as 192.168.x.x) may play and download without signing in. Their plays aren't
  counted unless they sign in. Requests through a tunnel always count as coming from the
  internet: Cloudflare's headers, or an address forwarded from a local connection, say so.
- `auth.players`: accounts that may play and download games until the owner says otherwise on
  the [admin page](#admin-page), which is where access is managed now. Anyone else who signs in
  keeps favorites only, in `userdata/users/<hash of the address>/`.
- **Guests** (owner only, on the admin page's Accounts tab): letting guests in for an hour, three
  hours, a day or until turned off gives everyone who isn't signed in, on the network or through
  the tunnel, what a player has: they play, download and pick versions, and keep favorites in
  their own browser. Their plays aren't counted as anyone's own (the activity log still has
  them). Accounts that can only browse can play while it's on too. It's for a demo: it takes
  effect at once, stays on across restarts (`userdata/server.json`) until its time is up or it's
  turned off, and the server logs each change.
- Someone not signed in keeps the shelf's filters in their browser. Games that don't run in the
  browser aren't hidden from anyone who can't play, and nothing on the page mentions them.
- The server refuses the game files, launch details and downloads to anyone who can't play;
  the buttons being gone is the page following suit. Box art, videos, manuals and extras stay
  open to everyone who can browse.
- Sessions last 60 days, in an HttpOnly cookie: `__Host-rgb_session` over https (which a page on
  another subdomain can't plant), `rgb_session` over plain http on the local network. A session
  started over plain http isn't honoured from the internet, since its cookie crossed the network
  unencrypted. `userdata/sessions.json` keeps only a hash of each session's token, so a copy of
  the file can't be used to sign in. The admin page signs an account out everywhere; deleting its
  entries there (or the whole file) does too.
- Someone who can't play isn't told there's playing to be had: the library and game pages they
  get leave out how each version plays, its size, files and problems, and `/api/me` leaves `play`
  out of what they may do. The API and the game files answer this app's own pages only: a
  request another website's page sets off (Sec-Fetch-Site: cross-site) is refused, so a page
  someone on the local network opens can't make the server prepare or pack games.
- A game hosted for friends ends when its host stops being allowed to play (guests turned off or
  their time up, an account taken down to browsing or blocked), and its link with it. A friend's
  link opens that one game's files and its console's BIOS, nothing else.
- Local-network trust: a request is from the internet when it carries Cloudflare's headers, a
  forwarded address, or, arriving through this PC's own loopback address, asks for a name that
  isn't a local one (what another tunnel or proxy running here forwards).

Getting a client ID (free, a few minutes):

1. Open [Google Cloud Console](https://console.cloud.google.com/), create a project (any name).
2. **APIs & Services → OAuth consent screen**: choose **External**, fill in the app name and
   your email, save. Leave it in **Testing** and add the Google accounts that will sign in as
   test users, or publish it (sign-in only asks for name, email and picture, which needs no
   review).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**: type **Web
   application**. Under **Authorized JavaScript origins** add `https://games.example.com` (your
   tunnel's address) and `http://localhost:3000` (`http://localhost:6502` for an installed copy). No redirect URIs are needed.
4. Copy the **Client ID** (not the secret; it isn't used) into `auth.googleClientId`, and
   restart the server.

Google only allows sign-in from an `https://` address or `http://localhost`, not from this PC's
network address (`http://192.168.x.x:3000`), so a phone signs in through a tunnel.

### Local accounts

For a server without Google sign-in, or for people without a Google account, the owner can turn
on **local accounts** (admin page, Accounts tab → Signing in): a username and password kept on
this server. Nothing goes in the config. Everything in the table above works the same for them;
a local account's access (play and download, browse only, blocked) is set on the same Accounts
tab, and the profile menu offers **Sign in with Local Account** under (or instead of) **Sign in
with Google**, which opens a popup asking for the username and password.

- **Turning them on without Google** makes the owner's account first: with no accounts at all,
  the owner is whoever is at this PC (`localhost`), and once there are accounts the owner is whoever
  signs in as that one. The admin page asks for its username and password and signs the browser
  in with it straight away. Turning local accounts off again ends every local session and goes
  back to no accounts (at this PC only, where the admin page still opens afterwards, so nobody
  locks themselves out of it). With Google set up, `auth.owner` stays the owner and local accounts
  are ordinary ones.
- **Making accounts**: the owner adds them on the Accounts tab (username, optional name,
  password, and whether they may play) and hands the password on; the owner can reset a
  password (which signs the account out everywhere) or delete an account (its favorites and
  plays go too). **Anyone can make their own local account** lets people sign up from the
  profile menu instead; like a first Google sign-in, a new account can only browse and shows
  under New sign-ins until the owner decides.
- **Passwords** (NIST SP 800-63B's rules): at least 8 characters and at most 200, not one of the
  100,000 most common from breaches (the UK NCSC's list, `server/data/common-passwords.txt`), and
  not the username. Kept only as a salted scrypt hash (N=2^15, r=8, p=3, one of OWASP's settings;
  an older hash is made again at its next sign-in) in `userdata/local-users.json`. Each person
  changes theirs from the profile menu, which asks for the current one; the owner can reset
  anyone's but their own. Every account has an id that a new password renews, and a session only
  counts while the id it was started with is the account's: a new password ends every other
  session, and a deleted account made again under the same username never inherits one.
- **Guessing**: sign-ins are limited by address, and failed ones by account from one address
  (10 a quarter of an hour) and by account from the internet as a whole (50 an hour; past that,
  only the local network can still sign in as it), so failing on purpose can't lock the owner out
  at home. A wrong username takes as long to turn down as a wrong password, and a blocked account
  is told the same. Failed sign-ins go in the server's log and the admin page's activity (Failed
  sign-ins), with the address. Sign-ups are capped overall too, and pause while 50 new accounts
  are waiting for the owner.
- Usernames are 2 to 32 letters, digits, dots, dashes or underscores, not case-sensitive.
  Elsewhere (the activity log, `accounts.json`) a local account goes by `<username>@local`.
- **Locked out** (the owner's password forgotten): at this PC, `npm run local-account -- password
  <username>` sets a new one, `npm run local-account -- off` turns local accounts off, and
  `npm run local-account -- list` lists them. Restart the server afterwards.

### Admin page

`/admin` (profile menu → Admin) is the owner's alone: the page shows anyone
else only that it's for the owner, and everything on it comes from `/api/admin`, which answers
the owner only. On a server with no sign-in at all (neither Google nor local accounts), that's
this PC alone: the page opens at `http://localhost:<port>/admin`, and tells anyone else on the
local network so. A request counts as this PC's when it arrives on the loopback address asking
for a local name, without a tunnel's or proxy's headers (`isThisPc` in
[server/lib/auth.js](../server/lib/auth.js)).

- **Overview**: plays, play time and downloads for today, 7, 30 or 90 days, a year or
  everything, split between signed-in accounts and people who weren't signed in (on the local
  network, guests, friends invited to a game); plays by day; the most played and downloaded
  games; plays and time by platform; the games that failed to start or stopped while being
  played; and who did what, by account and by address.
- **Right now**: who's playing what (for how long so far, from where, and whether the game is on
  screen or in a tab behind others), the games hosted for friends (with a button to end one), downloads being sent, games being unpacked or copied, and the
  latest plays. The tab shows how many games are being played.
- **Accounts**: **New sign-ins** first: people who signed in whom you haven't decided about (and
  the config doesn't name), with when and where from, and buttons to let them play, keep them
  browsing or block them. The tab shows how many are waiting. Then **Guests**, letting guests in
  for a demo (see above). Nothing on the site tells anyone
  that playing or downloading exists, or that it can be asked for: someone who can't play sees a
  site for browsing, and the server answers a request for a game's files "Not found". Below that,
  everyone who has signed in, and everyone the config names, with their access (Play and
  download, Browse only or Blocked), when they were last seen, their plays, play time, downloads
  and open sessions. Adding an address gives someone access before they first sign in. Blocking
  an account signs it out everywhere and stops it signing in; it can still browse like anyone
  not signed in. Access is kept in `userdata/accounts.json`; an account the admin page hasn't
  set gets what `auth.players` says.
- **Activity**: every event, newest first, filtered by what and who and searched by name,
  address or game: visits, plays, downloads (with how much was sent, and whether it finished),
  failures, sign-ins, and games hosted and joined with friends, each with its address, country
  (through the Cloudflare tunnel) and browser.
- **Server**: the version and build, uptime, library counts, the settings from the config, free space on the
  disks, the caches with a button to clear each (thumbnails, and unpacked or copied games;
  whatever is being played or downloaded is left alone), the logs' sizes and the
  [server log](#logs). Adding up the
  caches' sizes walks thousands of files, so it waits for the **Measure sizes** button.
- **LaunchBox folder** (Server tab): checks another folder the way the setup page does, and
  **Save and restart** writes it to the config as `launchboxRoot`. An installed copy's service
  restarts by itself (the server exits with code 75 and WinSW starts it again) and the page
  reloads once it's back; run from the project folder, restart it yourself.

The activity log is kept in `userdata/activity/`, a JSON Lines file a month, for
`activity.keepMonths` months (24); older months are deleted. A visit is counted once per person
and address every six hours. IP addresses are kept as they are. Visits from people not signed in
are counted at most 120 an hour, from at most 5000 people and addresses every six hours.

Play time: while a game is open the page checks in with the server every 30 seconds, saying
whether it's on screen, and says when the game is left; only time on screen counts. A page that
stops checking in (a closed laptop, a lost connection) is taken to have left 2½ minutes after
its last check-in, counting up to that check-in. If it checks in again within 12 hours (a phone
back from another app, a laptop woken up), the time after that is counted too, as its own
stretch; the time away isn't. Stopping the server with Ctrl+C keeps the time
of the games being played; a crash or a killed process loses it (their plays are still counted).

### Reaching it from anywhere: Cloudflare Tunnel

A tunnel gives the server an `https://` address on a domain you have on Cloudflare, without
opening a port on the router. `cloudflared` runs on this PC and passes the requests on to
`http://localhost:3000` (`localhost:6502` for an installed copy, in step 4 too).

1. Add a domain to Cloudflare (Dashboard → **Add a site**) and switch its nameservers to the
   ones Cloudflare gives you, if it isn't there already.
2. Install `cloudflared` on this PC: `winget install --id Cloudflare.cloudflared`.
3. In the Cloudflare dashboard, **Zero Trust → Networks → Tunnels → Create a tunnel**, type
   **Cloudflared**, name it, and run the install command it shows (it installs `cloudflared` as a
   Windows service with its token).
4. On the tunnel's **Public Hostname** tab add `games.example.com` (any subdomain), service
   **HTTP**, URL `localhost:3000`.
5. In `config.local.json`, set `"host": "127.0.0.1"` (the tunnel connects locally, and nothing
   else on the network needs to), and add the hostname to `allowedHosts`. Restart the server.

`allowedHosts` lets the server answer to the tunnel's hostname. It refuses host names it doesn't
know, however it's bound, which guards against DNS rebinding: `localhost`, this PC's own name
and bare IP addresses (`http://192.168.1.20:3000`) always work; add any other name the network
knows this PC by. The server trusts
the tunnel's `X-Forwarded-Proto` from localhost, so its cookies are marked Secure over HTTPS.

Edits made in LaunchBox are picked up automatically: the server rechecks the XML every few seconds
and reads again only the platforms whose XML changed (LaunchBox rewrites a platform's XML whenever
it records a play).

The DOS launchers (thousands of small files on a network share) are read in parallel at startup,
together with each launcher's `Extras` folder, where eXoDOS keeps a game's extras instead of listing
them in the XML (that's how a game page can show them without reading the share again). For a
game the index doesn't cover, its page reads its `Extras` folder once. The result is cached in
`dos-launchers.json` in `cacheDir` (`cache/` by default); with the cache the server starts at once and refreshes it in the
background. When the share can't be read, games keep what the previous
index knew about them, a run with nothing to fall back on isn't cached, and the launchers are read
again a few minutes later.

## Using it

The shelf opens on every platform at once. Along the top are the logo ([public/logo.webp](../public/logo.webp)), which goes home to every game with nothing
filtering it, a search box and the profile menu.

Down the left, the sidebar lists **All games**, **Multiplayer**, **Favorites**, **Recently
played**, **Top rated** (4 stars or more from at least 3 people) and **Random game**, then the
platforms and the genres, biggest first, each with a count and a small mark of its own — a platform its icon from LaunchBox (`Images\Platform Icons\Platforms`), a bolt
for Action, a compass for Adventure, a crosshair for Shooter. Above the grid are the filter
chips, each with the same: **Platform**, **Genre** (a tag), **Year** (a calendar) and
**Players** (two people) tick any number of choices (a decade or a whole category at a time),
**Only Favorites** is a switch, and **Sort**, which isn't a filter, sits apart at the far end
of the row. A chip goes teal once it's holding something, and says what.

The sidebar moves between shelves; the chips narrow whichever one is open. A sidebar row
starts afresh — it clears every other filter and leaves only itself — so the count beside it is
always the number of games you land on, and those counts don't shift as you go. Pressing the row
that's already on its own clears it too, and you're back at every game. From there the chips do
the rest: tick a second platform, add a genre, narrow to a decade.

**Random game** opens the page of one of the games the shelf is showing, and a game page has
**Next random game ›** in its top corner to keep going from there.

What the filters add up to names the page, in the heading over the grid: one platform under that
platform's own logo (LaunchBox's, from `Images\Platforms\<Platform>\Clear Logo`, or else one
listed in [server/data/platform-art.json](../server/data/platform-art.json) from elsewhere in
LaunchBox, such as a theme's, trimmed to the logo; a platform with neither shows its name), one genre or one of the lists under its name, and anything else —
nothing at all, or several platforms at once — under "All games". Under the name is how many
games the shelf is showing, and beside it the way back to all of them. The same goes in the
address: `/platform/Sega Genesis`, `/genre/Adventure`, `/multiplayer`, `/favorites`, `/recent`,
`/top`, with whatever else is filtering it in the query, so any shelf can be bookmarked and
reloaded.

Every entry in a menu carries how many games are behind it, counted with the *other* filters
applied but not its own: tick Year 1991 and the Platform menu says how many 1991 games each
platform has, while the Year menu still shows every year so you can move to another one. The
sidebar's rows are counted the same way. Entries nothing matches stay in place, greyed and
showing 0, so a menu never rearranges itself under the pointer.

LaunchBox files games under about ninety genres, most of them a broad name and a sub-genre after
a slash ("Sports / Soccer", "Board Game / Chess"). For browsing and filtering the shelf gathers
each game under the broad name, which brings it down to under forty; a handful of names that say
the same thing are gathered too ("Racing & Driving" with Racing, "Vehicle Simulation" and
"Construction and Management Simulation" with Simulation). A game's own page still shows the
genres LaunchBox gives it. The list is `GENRE_EXACT` and `GENRE_ALIASES` in
[public/js/util.js](../public/js/util.js).

Each tile is a card with the game's art, title, year and platform, and a star over the top
corner of the art to mark it a favorite. Titles run to one line and are cut with an ellipsis
where they're too long, so they line up across a row. The art runs the full width of its card
and right into the top corners, where the card's own rounding trims it. A row is only as tall as
the tallest art in it — a shelf of wide title screens packs much closer than one of tall box
scans — rather than every row keeping room for the tallest shape any game might have.

Art has a height it can't pass (`--tile-art` in [public/app.css](../public/app.css), 180px), and so
neither can a row. Anything taller is scaled down to it, keeping its shape, which takes its width
down as well and leaves it standing narrower than its card with the ground showing either side.
Wide art — a title screen, a screenshot — is usually under the cap and fills its card edge to
edge; upright box scans are usually over it and stand in the middle. At a six-across window that
is about two cards in three, and it holds every row to the same 243px.

**Click** a tile to select it: it lights up and the dock rises along the bottom for it. Until
then there's no dock at all, so the shelf has the screen to itself. From the dock, **Play**
starts the game right there, **Details** opens its page, and the star beside them marks it a
favorite. Clicking the selected tile again (or pressing Enter on it) opens the page too; Escape
lets the selection go and the dock with it.

The dock shows the game's year, platform and developer, its community rating with the number of
ratings, its genres, and a table of facts: publisher, players, how many versions it has and which
one Play would start, the size the browser loads before it runs, and when you last played it
("Never" until you have). Beside them is the picture box. Picking a game **plays its gameplay
video** where LaunchBox has one, without sound — click the video (or the speaker in its corner)
for sound, which then stays on for the games picked after it. The video is the first of the
game's pictures, and the arrows under the box step on to its screenshots. Only the game you pick
gets a video: a video per game as you go down the shelf would be a lot of loading for a glance.

While there's room for the sidebar the dock sits over the shelf alone, starting where the shelf
does, so the sidebar stays whole down to the bottom of the window. As the window narrows the
sidebar goes first — the chips do everything it did, and the dock takes the full width — and
then the dock's table of facts. On a phone the dock keeps what matters: the picture with its arrows, the
title and byline, and the three buttons.

"Size" is what the browser downloads before the game starts, from the size of the zip, folder
or ROM the version is made of. A CD game the server hasn't unpacked yet is only known packed, and
it's sent unpacked and bigger by an amount that varies, so those read "450 MB+". ScummVM versions
are whole folders, whose size means walking them, which the shelf can't do for hundreds of games
at once — those have no size until you open the game's page.

Click a game to open its page, which has the window to itself — no bar along the top, just the
game, with **‹ Back to the list** at the head of it. **Play** starts its default version, and
the **Versions** table below lists every version with its size, music choice, **Set as default**
and its own Play button. Where the window is too narrow to put the box art and the game's logo
side by side, the logo gives way: the art gets the room instead and the title is set in type. **In the box** holds the manual and the files in the game's `Extras` folder (hint books,
maps, feelies), each a click away. A game with a video of its own plays it
in a **Video** section above the screenshots, without sound until you turn it on. Screenshots
and art open full size; the arrow keys, the **Previous** and **Next** buttons or a sideways
swipe step through them.

**Players** and **Multiplayer** both come from what LaunchBox says about a game. The **Players**
chip offers **Single Player**, **2+ Players** and **3+ Players**, with how many games are behind
each. They're "at least" ranges rather than exact counts, and so overlap: a four-player game is
under 2+ and 3+ alike, since someone picking a game for two shouldn't have it kept back for
seating more. LaunchBox's own counts go up to 40 for the odd game, which is more rows than anyone
wants to read, and three ranges are enough to pick a game for who's in the room. Single Player is
the other side of 2+ — nothing says more than one can play — so between them the two hold every
game.

**Multiplayer** in the sidebar is that middle choice under a name of its own: the row sets the
Players menu to **2+ Players**, the way a platform or genre row sets its own menu, and the shelf
it opens is called Multiplayer and lives at `/multiplayer`. Ticking 2+ in the menu by hand lands
on exactly the same shelf; adding 3+ on top of it makes it Results again, like any other pair of
ticks.

What counts as multiplayer is LaunchBox's `MaxPlayers` wherever it has one: a game it seats at 1
isn't multiplayer however its play modes are marked. Only a game with no number at all falls back
to the modes, and a few hundred of those are marked Multiplayer or Cooperative without a count. A
game's own page and the dock show the exact number in words ("Up to 4, co-op").

Games marked as favorites in LaunchBox have a filled star on the shelf, and **Only Favorites**
or the **Favorites** row in the sidebar narrows to them. The star on a tile, the dock or a game's
page adds or removes one. LaunchBox is only ever read, so what you mark here is kept in
`userdata/settings.json` and merged with LaunchBox's own marks; unstarring a game LaunchBox calls
a favorite is remembered the same way.

**Recently played** and a game's **Played** line combine LaunchBox's play history with the games
played here: a game counts as played once it has started in the browser. Those plays are kept in
`userdata/plays.json`; LaunchBox's own history is left as it is.

| Key | Does |
|---|---|
| P | Play (the game on its page, or the selected or focused game on the shelf) |
| Space | Select the focused tile (pin the dock to it) |
| Esc | Let the selection go; on a game page, back to the shelf |
| / | Search |
| ← → | Previous and next picture when one is open full size |

Every platform in `platforms` (see [Configure](#configure)) is loaded at once, in one request
(`GET /api/library`), and the Platform chip groups them under LaunchBox's categories (Computers,
Consoles). That's about 550 bytes of JSON a game, a sixth of that gzipped; the shelf holds them
all and filters them in the browser, so switching platforms needs no round trip.

## How it works

- [server/lib/library.js](../server/lib/library.js) loads `Data\Settings.xml`, `Data\Platforms.xml`,
  `Data\Parents.xml` (platform categories), `Data\Emulators.xml` (where RetroArch keeps BIOS files)
  and `Data\Platforms\<Platform>.xml` into game records.
- [server/lib/media.js](../server/lib/media.js) indexes the image and video folders and matches files to games
  by title, the same way LaunchBox does. A title nothing is filed under is looked for again
  among the files that carry a year after the name, with the year ignored on both sides: eXoDOS
  names its videos "Wolfenstein 3D (1992).mp4" rather than "Wolfenstein 3D.mp4", and dates some
  of them a year apart from LaunchBox. That alone takes eXoDOS's videos from about 100 games
  to over 2,700.
- [server/lib/thumbs.js](../server/lib/thumbs.js) makes WebP thumbnails in `cacheDir` (`cache/` by default); an image it can't
  read (BMP, or a damaged file) is sent as it is.
- [server/lib/scummvm.js](../server/lib/scummvm.js) turns eXo launchers into playable versions and browser-build arguments;
  [server/lib/dosbox.js](../server/lib/dosbox.js) does the same for eXoDOS confs and
  [server/lib/emulatorjs.js](../server/lib/emulatorjs.js) for console ROMs and
  [server/lib/mame.js](../server/lib/mame.js) for arcade sets;
  [server/lib/romcache.js](../server/lib/romcache.js) unpacks CD games once and sends them as plain zips;
  [server/lib/webplay.js](../server/lib/webplay.js) indexes the versions of every game and serves game data to the browser builds.
  [server/lib/win3x.js](../server/lib/win3x.js), [server/lib/win9x.js](../server/lib/win9x.js) (with
  [server/lib/vhd.js](../server/lib/vhd.js)) and [server/lib/iigs.js](../server/lib/iigs.js) handle
  eXo's Windows 3.x, Windows 95/98 and Apple IIGS collections.
- Playing with a friend: [server/lib/netplay.js](../server/lib/netplay.js) is the EmulatorJS room
  server, [server/lib/ipx.js](../server/lib/ipx.js) and [server/lib/humblepeer.js](../server/lib/humblepeer.js)
  introduce DOS games' IPX peers, [server/lib/netbat.js](../server/lib/netbat.js) reads eXo's
  `network.bat`, and [server/lib/netplaylog.js](../server/lib/netplaylog.js) logs each session.
- Accounts and the admin page: [server/lib/auth.js](../server/lib/auth.js) (sign-in and what each
  account may do), [server/lib/accounts.js](../server/lib/accounts.js),
  [server/lib/localusers.js](../server/lib/localusers.js), [server/lib/access.js](../server/lib/access.js)
  (the checks routes make), [server/lib/activity.js](../server/lib/activity.js) and
  [server/lib/playing.js](../server/lib/playing.js) (the activity log and play time).
- [server/start.js](../server/start.js) starts the log, then either the
  [setup page](../server/setup.js) or the app ([server/index.js](../server/index.js), every route);
  [server/lib/datadir.js](../server/lib/datadir.js) decides where the config, `userdata/`,
  `cache/` and `logs/` live.
- [server/lib/standalone.js](../server/lib/standalone.js) packs one version into a folder that plays
  on its own, streamed as a zip by [server/lib/zipstream.js](../server/lib/zipstream.js);
  [public/offline/](../public/offline/) holds what goes in it (the page's styles and script, the
  player page and the runtime that stands in for the server). See
  [Taking a game with you](#taking-a-game-with-you).
- [public/play.html](../public/play.html) hosts the ScummVM engine, [public/playdos.html](../public/playdos.html)
  the js-dos player (served from `node_modules/js-dos/dist` at `/js-dos/`) and
  [public/emu/play.html](../public/emu/play.html) EmulatorJS (served from `vendor/emulatorjs/data` at
  `/emu/data/`) and [public/mame/play.html](../public/mame/play.html) MAME (served from `vendor/mame`
  at `/mame/engine/`); the app shows each full-window.
- All four load behind one card, in the same place and the same words, from
  [public/player/shell.js](../public/player/shell.js) and [public/player/shell.css](../public/player/shell.css):
  *Getting the game ready*, *Loading ScummVM* (or DOSBox, the console's core, or MAME), *Loading the
  system files*, *Loading &lt;game&gt;*, *Starting &lt;emulator&gt;*, and one card for a game that
  can't start or stops. The app's bar says the same as the page it frames. ScummVM and
  EmulatorJS report their own loading in their own boxes, so those are hidden and read back
  onto the card; what the emulators show once a game is running is left alone. A downloaded
  game uses the same two files, so it loads the same way with no server (see
  [public/offline/runtime.js](../public/offline/runtime.js)).
- The frontend is plain HTML, CSS and ES modules with no build step: [public/js/](../public/js/) has
  `shelf.js` (the grid, search and filtering), `filters.js` (the filter chips and their panels),
  `room.js` (game page), `dock.js` (the details dock), `details.js` (game records, fetched ahead
  for a tile the pointer rests on), `player.js` (the player pages in a frame, with
  `touchbuttons.js` and `typing.js` for phones) and `settings.js` (the profile menu), sharing
  `state.js` (app state) and `util.js` (DOM, API and formatting helpers), with `app.js` as the
  entry point. The other pages have one each: `admin.js`, `setup.js`, `join.js` (a friend's
  invite link) and `netplay-stats.js`. [public/player/](../public/player/) holds what the player
  pages share: the loading card, EmulatorJS's fixes and netplay engine, the video stream for
  playing by video, MAME's player, and on-screen buttons. The Inter
  font is served from [public/fonts/](../public/fonts/) rather than fetched from Google, so the
  first paint doesn't wait on the internet.
- The whole library is one shelf, and keeping many thousands of tiles smooth comes down to a few
  things in `shelf.js` and `app.css`. The tiles are put in a batch at a time as the grid is
  scrolled and, with a mouse, the rest in the browser's spare moments once typing stops, so
  the scrollbar, the End key and the browser's Find see every game. The grid is in chunks of
  eight rows, each a grid of its own with `content-visibility: auto`, so a chunk off the screen
  is neither laid out nor painted and a change anywhere costs a few chunks' worth rather than
  the whole library; a chunk's pictures are asked for when it comes within a screen of view.
  The search and the menus' counts are worked out in one pass over the library per keystroke.
  A game page lies over the shelf rather than replacing it, in a layer that scrolls on its
  own, so the shelf underneath is never laid out again and **Back to the list** is a matter
  of lifting the page off.

See [docs/launchbox-data-model.md](launchbox-data-model.md) for how LaunchBox stores its data.
