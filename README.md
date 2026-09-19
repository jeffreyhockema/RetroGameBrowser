<p align="center">
  <img src="public/logo.webp" alt="Retro Game Browser: Play / Explore / Relive" width="720">
</p>

# Retro Game Browser

**Your LaunchBox library, in any web browser, playable from anywhere, with friends.**

Retro Game Browser turns the [LaunchBox](https://www.launchbox-app.com) collection on your PC
into a website. Open it on a laptop, a tablet or a phone and your whole library is there: box
art, gameplay videos, manuals, maps and hint books. Press **Play**, and the game runs right in
the browser with nothing to install. Send a friend a link, and you're playing together a moment
later.

It only ever reads your LaunchBox folder and never writes to it, so LaunchBox itself carries on
exactly as before.

Version 0.96 (beta) · Windows · GPL-3.0-or-later

**On this page:** [What it does](#what-it-does) · [What plays](#what-plays-in-the-browser) ·
[What you need](#what-you-need) · [Good to know](#good-to-know-before-you-install) ·
[Get started](#get-started) · [Documentation](#documentation) · [License](#license-and-credits)

## What it does

### Your library, on every screen

- **The whole collection as one fast shelf.** A library of many thousands of games scrolls smoothly and
  filters instantly by platform, genre, decade, players, favorites and recently played. Every
  shelf has its own address, so it can be bookmarked.
- **Everything LaunchBox knows about a game:** its art, a gameplay video that plays as you pick
  it, screenshots, descriptions, ratings, the manual and eXo's extras (maps, hint books, feelies).
- **Picks up your changes.** Favorites and play history from LaunchBox show up, and edits made
  in LaunchBox appear within seconds. Favorites you mark here are kept by Retro Game Browser,
  apart from LaunchBox's.
- **Made for phones too,** with an on-screen gamepad laid out for each console, touch buttons for
  DOS and arcade games, and the phone's own keyboard for games that need typing. Gamepads work
  for up to four players.

### One-click online play with friends

Press **Play with a friend**, send the link, and your friend is in: no account, no install, no
port forwarding. Up to four players, anywhere.

- **Rollback netcode for a game that feels local.** Every player runs the game, and rollback, the
  technique modern fighting games use, hides the distance: your own presses show up in about
  45 ms whatever the ping, and a friend's late press is corrected so fast it's never seen. This
  is how the 8- and 16-bit consoles play, and over 1,300 arcade games, each checked to stay
  frame-perfect in step.
- **Video streaming for everything else.** Where two copies of an emulator can't be kept in step,
  the game streams from the host's browser to each friend, with their controller, keyboard and
  mouse sent back. It works with any game, and suits turn-based and slower games best.
- **DOS games over their own LAN.** 255 eXoDOS games with network play (DOOM, Descent, Duke
  Nukem 3D, Warcraft, Command & Conquer…) get the IPX network they were written for, set up in
  one click, with eXo's instructions for each game's multiplayer menu beside it.
- **Straight from browser to browser.** Players connect directly over WebRTC wherever the
  network allows, and live stats show each player's lag, ping and connection.

### Take a game with you

Any game can be downloaded as an **offline copy**: a folder with the game, its page, art and
manual, and the emulator it needs. Open the page in Chrome, Edge or Firefox and play, with no
server and no internet. (**Game files only** downloads just the game, for an emulator of your
own.)

### Share it, safely

- **Sign in with Google or with local accounts,** or with neither on a home network.
- **You decide who plays.** New sign-ins can only browse until you let them play, and guests
  can be let in for an hour, a day or until you turn it off, for a demo.
- **An admin page** shows what's being played right now, play time, downloads and activity, the
  caches and the server's log.
- **Reach it from anywhere** through a Cloudflare Tunnel, with no ports opened on your router.

## What plays in the browser

| Platform | Runs in | With a friend |
|---|---|---|
| NES, SNES, Genesis, 32X, TurboGrafx-16, Neo Geo AES, Atari 2600 / 5200 / 7800, Commodore 64 | [EmulatorJS](https://emulatorjs.org) (RetroArch cores) | Rollback |
| Nintendo 64, Sega CD, Saturn, PlayStation, Atari Jaguar | EmulatorJS | Video stream |
| Arcade | MAME 0.244, in a WebAssembly build of its own | Rollback support for over 1,300 games, video stream for the rest |
| Apple IIGS (eXoAppleIIGS) | MAME 0.244 | Video stream, with the friend's keyboard and mouse |
| MS-DOS (eXoDOS) | [js-dos](https://js-dos.com) (DOSBox-X) | The game's own IPX network play (255 games) |
| Windows 3.x (eXoWin3x) | js-dos (DOSBox-X) | |
| Windows 95 / 98 (eXoWin9x) | js-dos (DOSBox-X), booting eXo's Windows 98 | |
| Adventure games (eXoScummVM) | [ScummVM](https://www.scummvm.org), with every CD, floppy and music version eXo offers | |

Every game page offers each version the collection has (regions, floppy or CD, MT-32 music…) and
starts the best one for you. Other LaunchBox platforms can be added to browse, without Play.

The [guide](docs/guide.md#playing-in-the-browser) has each platform's details, controls and limits.

## What you need

**On the PC that serves the games**

- 64-bit Windows 10 or 11, and your LaunchBox library, on that PC or on a network share it can
  reach.
- About 1.1 GB for the program. Its caches grow as games are played: thumbnails up to 3 GB and
  unpacked CD games up to 20 GB, by default.

**In the library**

Retro Game Browser brings no games, ROMs or BIOS files; it plays what your library already has.

- **Consoles:** the ROMs LaunchBox has for the platform, under LaunchBox's own platform names.
  Sega CD and PlayStation games need their BIOS in RetroArch's `system` folder (it's found
  through LaunchBox's emulator settings), and Neo Geo games need `neogeo.zip` in their ROM
  folder. A Saturn BIOS is used when there is one. CD games are unpacked with the 7-Zip that
  comes with LaunchBox.
- **Arcade:** the games LaunchBox starts with MAME. The browser's MAME is version 0.244, so a
  ROM set made for 0.244 loads as it is; with a set from another version, the games MAME has
  renamed or re-dumped in between won't start.
- **DOS, Windows, Apple IIGS and ScummVM:** the [eXo](https://www.retro-exo.com) collections
  (eXoDOS, eXoWin3x, eXoWin9x, eXoAppleIIGS, eXoScummVM), installed into LaunchBox the way eXo
  sets them up.

**To play**

- A current Chrome, Edge or Firefox, or Safari on an iPhone or iPad. Nothing to install.
- A keyboard, a gamepad or a touch screen.

**Optional**

- A free Google OAuth client ID, for signing in with Google.
- A domain on Cloudflare, for a [tunnel](docs/guide.md#reaching-it-from-anywhere-cloudflare-tunnel)
  that makes the site reachable from outside your home. Friends elsewhere can only join your
  games when it is, and Google sign-in from a phone needs an `https://` address like the
  tunnel's.

## Good to know before you install

- **It's a beta,** built for and tested against one large LaunchBox library with the eXo
  collections.
- **Saved games stay in the browser you play in.** They aren't shared between devices, or with
  the emulators LaunchBox starts on the PC.
- **Games load into the browser's memory,** so the biggest don't play: DOS games over 700 MB,
  Windows games over 1.2 GB, console and arcade games over 1 GB (each limit can be changed).
  Their pages say so.
- **Not everything runs.** Some ScummVM engines crash in the browser build, a few dozen Windows
  9x games need 86Box, and a game on more than one CD can't swap discs under Windows. Games with
  a known problem say so on their page and are off the shelf unless you ask for them. Dreamcast
  and Amiga can't be played yet.
- **Windows 95/98 games have no offline copy,** since they boot eXo's Windows disk from the
  server.
- **Without sign-in set up,** everyone on your home network can play and shares one set of
  favorites, the admin page opens only on the PC itself (at `localhost`), and anyone coming in
  from the internet can only browse.

## Get started

### Windows installer

Download `RetroGameBrowser-Setup-<version>.exe` from the
[latest release](https://github.com/jeffreyhockema/RetroGameBrowser/releases/latest) and run
it. It installs a Windows service that starts with the PC, and opens a setup page that finds your LaunchBox folder, asks who may open the site, and
sets up sign-in. The site is then at `http://localhost:6502`, and, if you let it, at this PC's
address on your network.

**[installer/README.md](installer/README.md)** walks through it: installing, opening it on other
devices, updating, uninstalling, and what to do when something's wrong.

### From source

With Windows and [Node.js](https://nodejs.org) 22.2 or newer:

```sh
npm install
npm run fetch-scummvm && npm run fetch-emulators && npm run fetch-mame
npm start               # http://localhost:3000
```

The `fetch-` commands download ready-made browser builds of the emulators into `vendor/` (about
900 MB in all), each checked against its published checksum. They're independent: skip one and
its platforms browse without Play. js-dos comes with `npm install`.

If there's no LaunchBox at `C:\Users\<you>\LaunchBox`, the first start shows the same setup page
as the installer. `npm run setup` goes through it again.

| Command | Does |
|---|---|
| `npm start` | Runs the server |
| `npm run dev` | The same, restarting when server files change |
| `npm run setup` | Goes through the setup page again |
| `npm test` | Runs the tests |
| `npm run local-account -- list` | Local accounts: `list`, `password <username>`, `off` (when locked out) |
| `npm run package` | Builds the Windows installer into `dist\installer\` (needs [Inno Setup 6](https://jrsoftware.org/isinfo.php); see the [guide](docs/guide.md#installing-on-another-pc)) |

### Configuration

The setup page and the admin page cover the everyday settings. Everything else goes in
`config.local.json`, which overrides the defaults in [server/config.js](server/config.js):

```json
{
  "launchboxRoot": "D:\\Games\\LaunchBox",
  "host": "0.0.0.0",
  "port": 3000,
  "allowedHosts": ["games.example.com"]
}
```

| Setting | For |
|---|---|
| `launchboxRoot` | Where LaunchBox is. Read only, always |
| `host` | `127.0.0.1` for this PC only, `0.0.0.0` to let your network in |
| `port` | 3000 from source, 6502 for an installed copy |
| `platforms` | Which LaunchBox platforms show, and in what order |
| `allowedHosts` | Other names the server answers to, such as a tunnel's. Names it doesn't know are refused |
| `auth` | Google sign-in: the client ID, the owner and the players |

The file is in the project folder when run from source, and in `C:\ProgramData\RetroGameBrowser`
for an installed copy. The [guide](docs/guide.md#configure) lists every setting, with the size
limits, the caches and the multiplayer servers among them.

## Documentation

| | |
|---|---|
| **[Guide](docs/guide.md)** | Everything else: each platform's details and limits, how playing with friends works under the hood, accounts and the admin page, Google sign-in, Cloudflare Tunnel, every setting, and how the code is laid out |
| **[Installer readme](installer/README.md)** | For people installing it on Windows: setup, updating, troubleshooting |
| **[LaunchBox data model](docs/launchbox-data-model.md)** | How LaunchBox stores its data, and how it's read here |
| **[Third-party notices](THIRD_PARTY_NOTICES.md)** | The emulators, cores, fonts and libraries, and their licenses |

The server is Node.js with Express, in [server/](server/). The pages are plain HTML, CSS and ES
modules in [public/](public/), with no build step. The guide's
[How it works](docs/guide.md#how-it-works) says what each file does.

## License and credits

Retro Game Browser is free software under the GNU General Public License v3.0 or later
([LICENSE](LICENSE)).

It stands on the work of others. The emulators it fetches and ships keep their own licenses, as
do its typefaces and the other software in the installer: [ScummVM](https://www.scummvm.org),
[js-dos](https://js-dos.com) with DOSBox and DOSBox-X, [EmulatorJS](https://emulatorjs.org) and
the RetroArch cores it runs, and [MAME](https://www.mamedev.org), built for the browser with the
patches in [mame-wasm-build](https://github.com/jeffreyhockema/mame-wasm-build). Four of the
console cores are licensed for non-commercial use only. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for all of them.

LaunchBox is a product of Unbroken Software, and the eXo collections are eXo's; this project is
not affiliated with either.
