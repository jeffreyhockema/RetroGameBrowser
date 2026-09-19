# Retro Game Browser for Windows

Play your LaunchBox games in a web browser on any phone, tablet or computer in the house, or
from anywhere, and play them with friends by sending a link.

Retro Game Browser runs quietly in the background on the PC where your LaunchBox library is.
Open its address in a browser and your whole collection is there, with box art, videos and
manuals. Press **Play**, and the game runs right in the browser. It only reads your LaunchBox
folder and never changes anything in it.

This page covers installing it and looking after it. What it can do, and which systems it
plays, is on the project's page: https://github.com/jeffreyhockema/RetroGameBrowser

## What you need

- A 64-bit Windows 10 or 11 PC with your LaunchBox library on it, or on a network share the PC
  can reach.
- The games themselves, in LaunchBox. Nothing comes with Retro Game Browser: no games, ROMs or
  BIOS files. DOS, Windows, Apple IIGS and ScummVM games are supported through the eXo
  collections.
- About 1.1 GB of disk space for the program. Its caches (pictures, and CD games it has
  unpacked) grow as it's used, to about 23 GB at most.
- An administrator's permission, once, to install.
- A browser for playing: Chrome, Edge, Firefox, or Safari on an iPhone or iPad.

## Install

1. Run `RetroGameBrowser-Setup-<version>.exe` and follow the steps. Windows asks for permission,
   because it installs a background service. The installer isn't signed, so Windows may first
   say it "protected your PC": choose **More info**, then **Run anyway**.
2. At the end, your browser opens the **setup page** at `http://localhost:6502`. Until it's
   finished it answers on this PC only. It asks three things, and any of them can be changed
   later:
   - **Your LaunchBox folder.** It looks in the usual places and offers what it finds, or you
     type where it is (the folder with `LaunchBox.exe` in it). **Check** lists the platforms it
     found there.
   - **Who can open it:** every device on your home network, or only this PC.
   - **Signing in:** with Google accounts, with usernames and passwords of your own, with both,
     or not at all. Without sign-in, everyone on your home network can play and shares one set
     of favorites, the admin page opens only on this PC (at `http://localhost:6502/admin`), and
     anyone coming from the internet can only browse.
3. Press **Finish setup**. Your library appears; reading it the first time can take a minute.

From then on Retro Game Browser starts by itself with the PC. Open it from the Start menu, or go
to `http://localhost:6502` on this PC.

Signing in with Google is optional and takes about ten minutes to set up: it needs a free client
ID from Google, and the setup page shows how to get one. It can be added later.

### What the installer does

- Puts the program in `C:\Program Files\RetroGameBrowser`, with a Node.js of its own. Nothing
  else needs installing.
- Makes `C:\ProgramData\RetroGameBrowser` for your settings, accounts, favorites, caches and
  logs. Only administrators and the service can open it, since it holds the accounts.
- Registers the **Retro Game Browser** service, which starts with Windows and is started again
  if it ever stops. It runs as Windows' low-privilege Local Service account.
- Lets it through Windows Firewall on private networks only (port 6502).
- Adds Start menu entries: **Retro Game Browser** (opens the site), **Run the service as a
  Windows account**, **Repair the service** and **Uninstall**. A desktop shortcut is optional.

Your LaunchBox folder is never changed.

## Open it on your phone, TV or another computer

If setup let every device on your home network in, go to this PC's address followed by `:6502`,
for example `http://192.168.1.20:6502`. (Find the address under Windows Settings → Network &
internet → your connection → IPv4 address.) This PC's name works too: `http://my-pc:6502`.

To reach it from anywhere, or to sign in with Google from a phone, it needs a secure web
address. A free Cloudflare Tunnel gives it one without opening any ports on your router (you
need a domain name on Cloudflare). The guide explains how, step by step.

## Play with a friend

Open a game, press **Play with a friend**, and send the link it copies. Your friend opens it,
types a name and joins, with nothing to install and no account needed. Up to four can play.

- Most classic consoles, and over a thousand arcade games, play **in step**. Every player runs
  the game, and it feels as quick as playing in the same room.
- Newer consoles (PlayStation, Nintendo 64, Saturn) and the rest are **streamed** from your
  browser to your friends. That suits slower and turn-based games best.
- DOS games with network play (DOOM, Warcraft, Descent…) connect over the game's own network
  mode, with instructions shown beside the game.

For friends outside your home, the site needs to be reachable from the internet (see above).
Put that address under **Invite links** on the admin page's Server tab, so the link you send
is one your friend can open even when you start the game at `localhost`.

## Take a game with you

**Download → Offline copy** on a game's page gives you a folder you can keep: open its page in
Chrome, Edge or Firefox and play, with no internet and nothing installed.

## Good to know

- **Saved games** are kept by the browser you play in, so each device has its own, apart from
  the saves of the emulators LaunchBox starts.
- **Admin page:** as the owner, open your profile menu (top right) → **Admin** to see what's
  being played, decide who may play, let guests in for a while, and see the server's settings
  and log. With no sign-in set up, it opens only on this PC, at `http://localhost:6502/admin`.
- **Changing the LaunchBox folder:** admin page → **Server** tab → **LaunchBox folder** → **Save
  and restart**.
- **Disk space:** the admin page's Server tab shows how big the caches are and can clear them.
- **Updating:** run the newer installer over the old one. Your settings and data are kept, and
  so is the Windows account the service runs as.
- **Uninstalling:** use Windows' Apps list or the Start menu. It removes the service and the
  firewall rule, and asks whether to delete your data as well. LaunchBox isn't touched.

### Where things are

- The program: `C:\Program Files\RetroGameBrowser`
- Your data: `C:\ProgramData\RetroGameBrowser`
- Settings file: `C:\ProgramData\RetroGameBrowser\config.local.json`
- Logs: `C:\ProgramData\RetroGameBrowser\logs`
- The full guide: `C:\Program Files\RetroGameBrowser\docs\guide.md`

Most settings are on the setup and admin pages. The rest (the port, who on the network may
connect, Google sign-in, size limits) are in `config.local.json`, which the guide describes. Only
administrators can change it: open Notepad as administrator, edit and save it, then use Start
menu → Retro Game Browser → **Repair the service** to restart with the change.

## If something's wrong

**"Can't read the LaunchBox folder" on the setup page.** The background service can't see
folders inside your user folder (`C:\Users\<you>\LaunchBox`, where LaunchBox installs itself),
mapped drive letters or network drives.

- Choose Start menu → Retro Game Browser → **Run the service as a Windows account** and give it
  your own Windows account and password, then press **Check** again on the setup page. If you
  sign in to Windows with a Microsoft account, enter the account's name on this PC (such as
  `.\alex`) with the Microsoft account's password. A wrong password is caught, and the service
  goes back to the account it had.
- For a folder on another PC, type its network path (`\\server\share\LaunchBox`) instead of a
  drive letter like `X:`. A service never sees mapped drive letters.

**The site doesn't open on this PC.**

- Just after the PC starts, give it a couple of minutes: the service starts a little after
  Windows does, and reading the library takes longest then.
- Start menu → Retro Game Browser → **Repair the service** sets the service up again in a window
  that shows what happened. If another program already uses port 6502, it says which one.

**It opens on this PC but not on a phone or another computer.**

- Windows must count your network as **Private**: the firewall rule doesn't cover Public
  networks. Windows Settings → Network & internet → your connection → Network profile type.
- If setup was told **Only this PC**, change `"host"` to `"0.0.0.0"` in `config.local.json` (see
  Where things are), then **Repair the service**.
- Use `http://`, not `https://`, and don't forget `:6502`.

**Sign in with Google doesn't work from a phone.** Google only allows signing in at
`http://localhost` or at an `https://` address, not at an address like `http://192.168.1.20:6502`.
A phone signs in through the Cloudflare Tunnel's address, or with a local account.

**Forgot the owner's password** (local accounts). Open a Command Prompt as administrator and run:

    "C:\Program Files\RetroGameBrowser\service\local-account.cmd" password <username>

`local-account.cmd list` shows the usernames, and `local-account.cmd off` turns local accounts
off altogether.

**A game doesn't start.** Its page says why when the reason is known: too big for a browser, a
file missing from the library, or a known problem with that game in the browser.

**Logs.** `C:\ProgramData\RetroGameBrowser\logs` has the server's log (`server-<date>.log`, also
on the admin page's Server tab), a log of each install (`install-<date>.log`), and in `service\`
what the service last printed, for when it fails before its own log starts.

## More

The full guide, with every platform's details, all the settings and how it all works, is
`docs\guide.md` in the install folder, and online at
https://github.com/jeffreyhockema/RetroGameBrowser/blob/HEAD/docs/guide.md

Retro Game Browser is free software under the GNU GPL v3 or later (`LICENSE` in the install
folder). The emulators and other software it includes keep their own licenses
(`THIRD_PARTY_NOTICES.md` in the install folder). It isn't affiliated with LaunchBox or eXo.
