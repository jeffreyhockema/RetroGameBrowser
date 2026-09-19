# Third-party notices

RetroGameBrowser's own code is licensed under the GNU General Public License v3.0 or later
([LICENSE](LICENSE)). It works with, and in some cases ships, software made by others, each
under its own license, listed below.

No games, ROMs, BIOS files or LaunchBox data are part of this project. The app reads them from
your own LaunchBox folder.

## In this repository

| What | Where | License |
|---|---|---|
| [Inter](https://github.com/rsms/inter) typeface | `public/fonts/inter-*.woff2` | SIL Open Font License 1.1 ([public/fonts/OFL.txt](public/fonts/OFL.txt)) |
| [Google Sans](https://github.com/googlefonts/googlesans) typeface (one weight) | `public/fonts/google-sans-latin-500.woff2` | SIL Open Font License 1.1 ([public/fonts/OFL.txt](public/fonts/OFL.txt)) |
| The 100,000 most common passwords from breaches, published by the UK's National Cyber Security Centre, as collected in [SecLists](https://github.com/danielmiessler/SecLists) | `server/data/common-passwords.txt` | NCSC's list; SecLists is MIT |
| MAME 0.244's list of machines (made from `mame -listxml`) | `server/data/mame0244.json` | Data from [MAME](https://github.com/mamedev/mame), GPL-2.0 |
| ScummVM's game IDs (made from `scummvm --list-games`) | `server/data/scummvm-engines.json` | Data from [ScummVM](https://github.com/scummvm/scummvm), GPL-3.0-or-later |

## Fetched into `vendor/`, and packed into the installer and offline copies

These aren't in the repository. `npm run fetch-*` downloads them, the Windows installer carries
them, and a game's **Offline copy** includes the one engine it plays in (its README.txt names it).

| What | License | Source |
|---|---|---|
| ScummVM (browser build, from [scummvm.kuendig.io](https://scummvm.kuendig.io)) | GPL-3.0-or-later | <https://github.com/scummvm/scummvm> |
| [js-dos](https://js-dos.com) 8 (DOSBox and DOSBox-X), from npm | GPL-2.0 | <https://github.com/caiiiycuk/js-dos> |
| [EmulatorJS](https://emulatorjs.org) 4.2.3, from npm | GPL-3.0 | <https://github.com/EmulatorJS/EmulatorJS> |
| MAME 0.244, compiled to WebAssembly | GPL-2.0 as a whole, some files under less restrictive licenses (`vendor/mame/COPYING`) | <https://github.com/mamedev/mame> (tag `mame0244`), built with the patches and scripts in <https://github.com/jeffreyhockema/mame-wasm-build> |

EmulatorJS runs RetroArch cores, each under its own license. A core's full license text is
`license.txt` inside its `vendor/emulatorjs/data/cores/<core>-wasm.data` archive, except for
Stella 2014, Virtual Jaguar and Yabause, whose archives have none. Their texts are in their
source repositories under [github.com/libretro](https://github.com/libretro), and every core's
source is linked from [EmulatorJS](https://github.com/EmulatorJS).

| Core | Systems | License |
|---|---|---|
| FCEUmm | NES | GPL-2.0 |
| Snes9x | SNES | Snes9x license (non-commercial) |
| Genesis Plus GX | Genesis, Sega CD | Genesis Plus GX license (non-commercial) |
| PicoDrive | 32X | PicoDrive license (non-commercial) |
| Yabause | Saturn | GPL-2.0 |
| PCSX-ReARMed | PlayStation | GPL-2.0 |
| Mupen64Plus-Next | Nintendo 64 | GPL-2.0 |
| Stella 2014 | Atari 2600 | GPL-2.0 |
| a5200 | Atari 5200 | GPL-2.0 |
| ProSystem | Atari 7800 | GPL-2.0 |
| Virtual Jaguar | Atari Jaguar | GPL-3.0 |
| Mednafen PCE | TurboGrafx-16 | GPL-2.0 |
| FinalBurn Neo | Neo Geo AES | FinalBurn Neo license (non-commercial) |
| VICE x64sc | Commodore 64 | GPL-2.0 |

The non-commercial licenses allow free redistribution but not selling, or bundling with anything
that's sold.

## Also in the Windows installer

| What | License |
|---|---|
| [Node.js](https://nodejs.org) (`node.exe`) | MIT and others (`node\LICENSE` in the install folder) |
| [WinSW](https://github.com/winsw/winsw) 3.0.0-alpha.11, which runs the app as a Windows service | MIT (`service\WinSW-LICENSE.txt`) |
| The npm packages in `node_modules`: express, socket.io and ws, fast-xml-parser, yauzl (MIT); flatbuffers (Apache-2.0); sharp (Apache-2.0) with libvips (LGPL-3.0-or-later) | Each package's own license file in its folder |
