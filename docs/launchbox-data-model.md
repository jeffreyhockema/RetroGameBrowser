# LaunchBox Data Model

How LaunchBox stores a library, as far as RetroGameBrowser needs to read it: which files hold
what, the fields that matter, how media is found, and how the eXo collections and console ROM
sets are laid out. Observed on LaunchBox 14.0.1 with the eXo collections; LaunchBox doesn't
document these files, so other versions may differ.

> **Constraint:** the app never writes to anything under the LaunchBox folder. XML is only read;
> if the SQLite metadata DB were ever used, it would have to be opened with
> `?mode=ro&immutable=1` (or a copy queried) so SQLite doesn't create `-wal`/`-shm` files.

All relative paths in LaunchBox data are relative to the LaunchBox root (`launchboxRoot` in the config).

## Where things live

| Path | What it is | What the app uses it for |
|---|---|---|
| `Data\Platforms\<Platform>.xml` | **The user's library** for one platform: games, extras, alternate names | The games |
| `Data\Platforms.xml` | Platform definitions, media-folder mappings (`PlatformFolder`), categories | Platform list, where media lives |
| `Data\Parents.xml` | Tree: platforms/playlists → categories (Consoles / Arcade / Computers) | Platform categories |
| `Data\Playlists\*.xml` | User playlists (lists of game IDs) | Not used |
| `Data\Settings.xml` | App settings, including **image type priorities** and **region priorities** | Which image to show |
| `Data\Emulators.xml` | Emulator definitions (ScummVM games don't use one) | RetroArch's BIOS folder, which games are arcade (MAME) |
| `Metadata\LaunchBox.Metadata.db` | SQLite copy of the **global** LaunchBox Games DB, not the user's library | Not used |
| `Images\<Platform>\<Media Type>\[<Region>\]` | Artwork, found **by file name convention** | Images |
| `Manuals\<Platform>\`, `Music\<Platform>\`, `Videos\<Platform>\` | Manuals, soundtracks, video snaps | Media |
| `eXo\` | The eXo collections: launchers, game data, their emulators | Playing, extras |

Folders to ignore: `Data - Copy\`, `Backups\`, `xml\`, `xml.delete\`, `Images\Cache-LB`, `Images\Cache-BB`.

### Folders reached through a broken link

A big collection is sometimes kept on another drive and reached through a junction (`eXo\eXoDOS`
pointing at another drive's `eXo\eXoDOS`, say). If that drive later becomes a network share, the
junction stops resolving ("reparse point buffer is invalid") although the files are still there.
The server supports fallback roots for this (`fallbackRoots` in the config, none by default; see
`server/lib/paths.js`): when a path under `launchboxRoot` can't be read, it retries the same
relative path under each fallback root.

## A platform's XML (`Data\Platforms\<Platform>.xml`)

Root `<LaunchBox>` with three sibling element types (flat, not nested):

| Element | Links by |
|---|---|
| `Game` | `ID` (GUID) |
| `AdditionalApplication` | `GameID` → `Game.ID` |
| `AlternateName` | `GameID` → `Game.ID` |

### `Game` fields worth using

| Field | Notes |
|---|---|
| `ID` | GUID, stable primary key |
| `Title` | Also the key for finding images |
| `SortTitle` | Often empty; use when present, else `Title` (e.g. "King's Quest 4") |
| `Notes` | Description (multi-paragraph plain text) |
| `ReleaseDate` | `YYYY-MM-DD`; many are `YYYY-12-31` placeholders for year-only |
| `Developer`, `Publisher` | |
| `Genre` | **Semicolon-separated** list: `Action; Adventure; Role-Playing` |
| `Series` | Semicolon-separated; eXo puts tags here, like `Theme: Fantasy; Discworld Universe` |
| `PlayMode` | Semicolon-separated: `Single Player; Multiplayer; Cooperative` |
| `MaxPlayers` | Not always filled |
| `Rating` | ESRB string, e.g. `E - Everyone`, `M - Mature`, `Not Rated` |
| `Source` | `Commercial` / `Shareware` |
| `ReleaseType` | `Released` / `Homebrew` |
| `Region` | Mostly empty for computer games |
| `CommunityStarRating` / `…TotalVotes` | 0–5 float from the LaunchBox DB |
| `StarRating` / `StarRatingFloat` | The user's own rating |
| `Favorite`, `Completed`, `Hide`, `Broken` | Booleans `true`/`false` |
| `PlayCount`, `PlayTime` (seconds), `LastPlayedDate`, `DateAdded`, `DateModified` | ISO 8601 with offset |
| `DatabaseID` | Key into the LaunchBox Games DB |
| `WikipediaURL` | |
| `VideoUrl` | YouTube/Steam URL (note the casing: `VideoUrl`, not `VideoURL`) |
| `ManualPath` | e.g. `Manuals\ScummVM\Gobliiins 1 (Multi-Platform).pdf` |
| `MusicPath` | May point at a folder that no longer has the file |
| `ApplicationPath` | What LaunchBox starts: an eXo launcher `.bat`, or a console game's ROM |
| `ConfigurationPath` | eXo's `install.bat` (install/uninstall/config menu) |
| `RootFolder` | eXo's launcher folder for the game |

Always empty or irrelevant for eXo games: `VideoPath`, `ThemeVideoPath`, `Emulator`,
`CommandLine`, `ScummVMGameType`, `ScummVMGameDataFolderPath`, `CloneOf`, all `Android*`, all
`*AutoHotkeyScript`, startup/pause-screen settings, `UseDosBox`/`UseScummVM` (false: eXo's `.bat`
handles it).

**Don't trust the `Missing*Image` / `MissingVideo` flags**: they're a stale cache, and can say a
game has box art it doesn't. Look at the files instead.

Fields vary between games (some have `VideoUrl`, `Installed`, `Status`, some don't), so parse
tolerantly.

### `AdditionalApplication`

`Id`, `GameID`, `Name` (a label: "Hintbook", "Map", "Journal", "Copy Protection Codes", …),
`ApplicationPath`, `Priority`, plus launch flags. For computer games these are mostly documents
and feelies (`.pdf`, `.jpg`, `.txt`, `.htm`, `.mp3`) in the game's `Extras\` folder, shown as the
game's extras. For console games they're other regional releases (see below).

### `AlternateName`

`GameID`, `Name`, `Region`: e.g. "Discworld 2". Useful for search.

## Image resolution

Images are **not** referenced in the game XML. LaunchBox finds them by convention:

```
Images\<Platform>\<Media Type>\[<Region>\]<SanitizedTitle>-<NN>.<ext>
```

- **The folder for each media type** comes from `Data\Platforms.xml` → `PlatformFolder` rows
  (`Platform`, `MediaType`, `FolderPath`), usually `Images\<Platform>\<MediaType>`, plus
  `Videos\<Platform>`, `Videos\<Platform>\Theme`, `Manuals\<Platform>`, `Music\<Platform>`.
  Read this table rather than hard-coding: a platform may point elsewhere.
- **SanitizedTitle** is `Title` with `\ / : * ? " < > | '` replaced by `_`:
  "Al Emmo and the Lost Dutchman's Mine" → `Al Emmo and the Lost Dutchman_s Mine`.
- **`-NN`** is a two-digit sequence (`-01`, `-02`, …) for several images of the same type.
- **The region subfolder** is optional (`Box - Front\North America\Discworld-01.jpg`). Pick by
  `Settings.xml` → `RegionPriorities`, then no region, then any.
- Extensions are mixed (`.png`, `.jpg`, `.gif`). Match case-insensitively.
- Match the whole sanitized title, never a prefix ("Zork" vs "Zork Zero").
- Videos follow the same convention (`VideoPath` is empty). eXoDOS names some videos with the
  year after the title ("Wolfenstein 3D (1992).mp4"), sometimes a year off from LaunchBox's.

**Which image type to show** for each slot comes from `Settings.xml` → `Settings`:

| Setting | Typical value |
|---|---|
| `FrontImageTypePriorities` | GOG Poster, Steam Poster, Epic Games Poster, Amazon Poster, **Box - Front**, Box - Front - Reconstructed, Advertisement Flyer - Front, … |
| `BackImageTypePriorities` | Box - Back, Box - Back - Reconstructed, … |
| `BackgroundImageTypePriorities` | … Fanart - Background |
| `ScreenshotsImageTypePriorities` | **Screenshot - Gameplay**, Screenshot - Game Title, … |
| `MarqueeImageTypePriorities` | Arcade - Marquee, Banner, Steam Banner |
| `Box3dImageTypePriorities` | Box - 3D |
| `CartFrontImageTypePriorities` | Cart - Front, Fanart - Cart - Front, Disc, Fanart - Disc |
| `VideoTypePriorities` | Theme Video, Video Snap, Recording, Trailer |

Images are full-size originals with no thumbnails, so the app makes and caches its own, **outside**
the LaunchBox folder.

## eXoScummVM (ScummVM platform)

```
eXo\eXoScummVM\
  !ScummVM\<Game Folder>\          ← RootFolder: the game's launcher folder
      <Game Folder>.bat            ← ApplicationPath: launcher
      install.bat                  ← ConfigurationPath: install/uninstall + aspect/fullscreen prompts
      Extras\                      ← manuals, maps, hint books (the AdditionalApplications)
  <Game Folder>\                   ← the game's data (present = installed)
eXo\scmvm\scummvm.exe              ← the ScummVM build the launchers use (also stable\, svn\, svn2.3\)
eXo\util\                          ← helper programs the .bat files use
```

- Game folder names are eXo style, `Title (Platform variant)`: `Oo-Topos (DOS)`,
  `7th Guest, The (Multi-Platform)`.
- A game is installed when `eXo\eXoScummVM\<Game Folder>\` exists.
- The launcher runs `.\scmvm\scummvm.exe --no-console -F … -p".\eXoScummVM\<Game Folder>" <gameId>`
  from `eXo\`. The last word is the **ScummVM game ID** (`ootopos`, `t7g`, `toltecs`), which the
  app reads to start the browser build of ScummVM.

## eXoDOS (MS-DOS platform)

The XML has `Game` and `AlternateName` rows and **no** `AdditionalApplication` rows: a game's
extras are only in its `Extras\` folder. `ManualPath` points at `Manuals\MS-DOS\<Game (Year)>.TXT`
or `.pdf`.

```
eXo\eXoDOS\
  <Game (Year)>.zip                ← the game (from under a megabyte to several gigabytes): its folder,
                                     with run.bat, and network.bat for games with network play
  !dos\<GameDir>\                  ← RootFolder: launcher files, one folder per game
      <Game (Year)>.bat            ← ApplicationPath: a stub that runs eXo\util\launch.bat
      install.bat                  ← ConfigurationPath: unpacks the zip to eXo\eXoDOS\<GameDir>\
      dosbox.conf                  ← the game's DOSBox config (sometimes also tandy.conf, dosbox_cga.conf, dosbox2.conf …)
      exception.bat                ← optional: a menu ("DOSBox or ScummVM?", "PCjr or CGA") or a helper program
      Extras\                      ← manuals, novels, maps, videos (NOT listed in the XML; list the folder)
  !dos\!French\<GameDir>\ …        ← localized variants (not used here)
  <GameDir>\                       ← an unpacked game ("installed")
eXo\emulators\dosbox\<build>\      ← the DOSBox build each game uses, per eXo\util\dosbox.txt
                                     (DOSBox 0.74, ECE, Staging, Daum, DOSBox-X, …)
eXo\mt32\                          ← MT-32/CM-32L ROMs and SoundCanvas.sf2, shared with ScummVM
```

- `dosbox.conf` `[autoexec]` mounts with host paths relative to `eXo\`: `mount c .\eXoDOS\<GameDir>`
  (or `mount c .\eXoDOS\` then `cd <GameDir>`), `imgmount d .\eXoDOS\<GameDir>\cd\x.cue -t cdrom`
  for CD games, and a few `boot` floppy images. The folder name in the conf can differ in case
  from the zip's top-level folder (`11thhour` vs `11thHour/`), which matters on a case-sensitive
  file system.
- `[midi]` often points at `mt32.romdir`/`fluid.soundfont`, with `mididevice=mt32` or
  `fluidsynth` for some; ECE-only keys (`oplemu=nuked`, `[pci] voodoo`) appear too.
- Games set up for network play turn on `ipx=true` in their conf.
- `UseDosBox`, `DosBoxConfigurationPath` and `Emulator` are unused: eXo's `.bat` does everything.

## eXoWin3x (Windows 3x platform)

Every game has an `AdditionalApplication` for "Pixel Perfect & Shader options"; the rest are
manuals. `UseDosBox` is false throughout, as for eXoDOS.

The games are **already installed**, not zipped:

```
eXo\eXoWin3x\
  <GameDir>\                       ← the installed game, with its own Windows 3.1, drivers and CD image
      WINDOWS\                     ← S3 864 display driver at 640x480x256, SB16 sound
      SB16\, drivers\s3, drivers\sb
      cd\                          ← the CD image (cd.cue/cd.iso), for CD games
      AUTOEXEC.BAT, CONFIG.SYS, RUNEXIT.EXE, WIN386.SWP
  <Game (Year)>\                   ← empty folders, left from eXo's own install step
  !win3x\<GameDir>\                ← launcher folder, the same shape as eXoDOS's !dos
      <Game (Year)>.bat, install.bat, dosbox.conf, Extras\
```

- `dosbox.conf` `[autoexec]` mounts with host paths relative to `eXo\`, as eXoDOS does:
  `mount c .\eXoWin3x\<GameDir>`, often `imgmount d ...\cd\cd.cue -t cdrom`, then usually
  `@win runexit <exe>` (`RUNEXIT.EXE` quits Windows when the game ends). Some games call a
  `run.bat` menu instead, and a few boot a hard disk image (`imgmount c <x>.img`, `boot -l c`).
- `machine=svga_s3` in nearly every conf, `memsize` 32 to 64; some games fix `cycles` high.
- Most of a game's size is its CD image. `WIN386.SWP` is Windows' swap file, left in the install,
  and can be large. Some installs are empty (every file 0 bytes): eXo's install never finished
  for them.
- The DOSBox build comes from the `.bat`: mostly `dosbox\ece`, a few `svn`, `x` or `svn_2`.

## eXoWin9x (Windows 9x platform)

```
eXo\eXoWin9x\
  <year>\<Game (Year)>.zip          ← deflated zips: <Game (Year)>\<Game (Year)>.vhd plus CD
                                      images (.iso, .cue+.bin, .ccd) or a zip for drive E:
  <year>\<Game (Year)>\             ← where eXo's install.bat unpacks a zip
  !win9x\<year>\<GameDir>\          ← launcher: <Game (Year)>.bat, Install.bat, Play.conf, Extras\
eXo\emulators\dosbox\x98\parent\    ← the shared Windows disks, dynamic VHDs with 2 MB blocks:
  W98-C.vhd (most games), W98-C-Net.vhd and W98-C-Net2.vhd (network games), win98jap.vhd,
  Win95DX8.vhd, win98chinese.vhd
```

- The launcher `.bat` calls `util\9xlaunch.bat` (DOSBox-X, `emulators\dosbox\x98\dosbox-x.exe`,
  with Play.conf) or, for a few games, `9xlaunch86Box.bat`/`9xlaunch86BoxME.bat` (86Box, with
  Play.cfg and no Play.conf).
- Play.conf `[autoexec]`, host paths relative to `eXo\`: `vhdmake -f -l <parent> <child>` (a fresh
  differencing disk every launch), `imgmount c <child>`, `imgmount d <game>.vhd`, then drive E: as
  `imgmount e <CD files…> -t cdrom -ide 2m` or `mount e <x>.zip`; some add an F: CD; then
  `boot -l c`. A few copy `.ini` files from D: to C: with xcopy before booting.
- The Windows disk's StartUp folder runs `C:\eXo\Setup.vbs`: it copies `D:\Windows` over
  `C:\Windows`, imports `D:\reg.reg` and runs the shortcut in `D:\Windows\Desktop`. Game disks are
  2 GB FAT32 VHDs holding a few MB of shortcuts and registry entries; most games run from their CD.
- Conf hardware: `machine=svga_s3`, `memsize=64`, `cputype=pentium_mmx`, `sbtype=sb16`, ISA PnP
  BIOS on, IDE `pnp=true`, `serial1/2=dummy`, and for network games `ne2000=true` with
  `backend=pcap`. Windows' display driver is "S3 Trio32/64 PCI" at 1024x768 and 16-bit colour.

## Consoles (RetroArch ROM sets)

Console platforms (and the Commodore 64 and Amiga) run through RetroArch in LaunchBox
(`Data\Emulators.xml`: `Emulators\RetroArch\retroarch.exe`, one `EmulatorPlatform` row per
platform with its core, e.g. `-L "cores\snes9x_libretro.dll" -f`). Arcade games run through MAME.

- `ApplicationPath` is the ROM: `Games\<Platform>\<No-Intro name>.zip` (`.7z` for CD systems).
  File names carry No-Intro tags: `Suikoden (USA) (Rev 1).7z`, `Sonic the Hedgehog (USA, Europe).zip`.
  Neo Geo AES uses MAME set names (`kof98.zip`), with the `neogeo.zip` BIOS set in the same folder.
- `Version` repeats the tags (`(Japan)`), and `Region` is LaunchBox's region (`North America`,
  `Japan`, `World`, …). `RootFolder`, `ManualPath` and `MusicPath` are empty.
- `AdditionalApplication` rows are the game's other regional releases, all with
  `UseEmulator=true` and a name like `Play (Japan) Version...`. They're versions, not extras.
- BIOS files are in RetroArch's `system` folder under their usual names: `scph5501.bin`
  (PlayStation), `bios_CD_U.bin`, `us_scd1_9210.bin`, `eu_mcd1_9210.bin`, `jp_mcd1_9112.bin`
  (Sega CD), `saturn_bios.bin` (Saturn).
- Amiga games are WHDLoad installs (a folder with a `.Slave`, or a bare `Disk.1` image), not plain
  disk images, which the browser core can't start.
- `ThirdParty\7-Zip\7z.exe` ships with LaunchBox; the app runs it (reading only) to unpack CD
  archives into its own cache.

## Arcade (MAME)

A game is an arcade game when its emulator in `Data\Emulators.xml` starts `mame.exe`.
`ApplicationPath` is the set's zip in MAME's ROM folder; its `AdditionalApplication` rows
(`Play … Version`) are the set's clones. The sets are a split set made for one MAME version, so
a clone needs its parent's zip, and BIOS and device sets (`neogeo.zip`, `qsound_hle.zip`) sit in
the same folder. CHDs are in a folder named after the set, and samples in MAME's `samples` folder.

## `Data\Platforms.xml`

- `Platform` rows: `Name`, `ReleaseDate`, `Developer`, `Notes`, `Category`, `SortTitle`,
  `HideInBigBox`, …
- `PlatformFolder` rows: the media folder mapping (see above).
- `PlatformCategory` rows: Consoles, Arcade, Computers.
- `Images\Platforms\…`, `Images\Platform Icons\…`, `Images\Platform Categories\…` hold
  platform-level art.

## `Data\Parents.xml`

A flat list of `Parent` rows forming the navigation tree. Each row has one child key
(`PlatformName` | `PlaylistId` | `PlatformCategoryName`) and one parent key
(`ParentPlatformName` | `ParentPlaylistId` | `ParentPlatformCategoryName`). `Platform.Category`
in Platforms.xml can be empty for every platform, so the app takes each platform's category from
here. A platform can be in the tree with no `Platforms\<Name>.xml` of its own; skip it.

## `Data\Playlists\*.xml`

One `Playlist` header (`PlaylistId`, `Name`, `NestedName`, `SortBy`, `AutoPopulate`, …) plus
`PlaylistGame` rows (`GameId`, `LaunchBoxDbId`, `GameTitle`, `GameFileName`, `GamePlatform`,
`ManualOrder`). Auto-populated playlists may also carry `PlaylistFilter` rows.

## `Metadata\LaunchBox.Metadata.db` (SQLite, EF Core)

A local copy of the global LaunchBox Games DB, **not** the user's library; it joins on
`DatabaseID`. Tables include `Games` (`DatabaseID`, `Name`, `Overview`, `ReleaseYear`, `Genres`,
`Developer`, `Publisher`, `ESRB`, `MaxPlayers`, `Cooperative`, `CommunityRating`, `VideoURL`,
`WikipediaURL`, `SteamAppId`, `Platform`), `GameImages` (`FileName`, `DatabaseId`, `Type`,
`Region`, `CRC32`), `GameAlternateTitles`, `Platforms`, `PlatformAlternateNames`, `Emulators` and
`EmulatorPlatforms`. It lists more art than a library usually has on disk. It's mostly
redundant with the platform XML for this app's purposes, and the app doesn't read it.
