# Setting up Office Mumble

Two kinds of machine: the server, which holds the office and is where the colleagues' apps are made, and the
colleagues' machines, which only install what they are handed. The first chapter is for working on the code.

## Everything at once

To see a change on this machine — to the server or to the client — `harness/dev.sh` (`harness\dev.cmd` on
Windows): the floor rebuilt and restarted, the app rebuilt and started, about a minute each time.

On a machine that has the toolchain, one script builds all of it:

```
harness/make.sh        # Linux and macOS
harness\make.cmd       # Windows
```

It builds the server in release, the browser client, the harness pages and — unless `--no-app` / `-NoApp` —
the desktop app for the platform it runs on. `build` packs the app only when an office is named; the app
scenarios below ask for it themselves.

None of the scripts needs a parameter. The office the app is for comes from `OFFICE_MUMBLE_SERVER` if it is
set, else from the office named last time — kept in `.office-mumble/server` — else this machine, by its current
address. Name it once and it is remembered; that is what makes `recipes/pack-app.sh` a single word.

The work lives in `harness/recipes/steps/`, one script per action, and the make script only calls them:

- `server-build` — the server, release
- `server-start` / `server-stop` / `server-status` — the floor, in the background, with a log and a pid file
- `web-build` — the browser client
- `sheet-build` — the harness pages (the art sheet)
- `app-build` — the desktop app, packed, for the platform it runs on

Any of them can be run alone: `sh harness/recipes/steps/server-start.sh`. The `.ps1` beside each `.sh` is the same
action in PowerShell.

The scenarios are made of those actions and live in `harness/recipes/`:

- `build` — server, client, harness pages, and the app when a server is named (what `make` calls)
- `serve` — build the floor and leave it running
- `restart` — stop, rebuild, start: the command after changing the server
- `local` — the whole office on this machine, freshly built: floor restarted, app rebuilt and started
- `start-app` — build the app for this platform and start it
- `pack-app` — the browser client, then the app for this platform

`sh harness/recipes/restart.sh` — that is the whole of it.

The app also **pins the server's certificate**, so that step asks the running server for the one it is using
right now — which means the server has to be reachable while the app is built. Without a reachable server the
build uses the certificate already in `.office-mumble/` and warns that it may be stale; if there is none, it
stops and says why. That is the one part of a build that needs the server up.

It builds and does not start. A server that is already running keeps running, with the build it was started
with; the script says so at the end. Restart it when you want the new one.

## The server

**Install:** Node 22+ and Rust. On Windows, Rust also wants the C++ build tools — the .NET SDK does not carry
them:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
rustup default stable-msvc
```

**Run:**

```
harness\office.cmd        # Windows
harness/office.sh         # macOS, Linux
```

It installs what the build needs where it can (winget on Windows, rustup and Homebrew on a Mac; on Linux it
names what is missing), builds the server and starts it — the certificate is issued for this machine on that
start — and then builds the colleagues' app of this platform for this server, reads back that the certificate
and the address are really inside it, and leaves the installer in `handout/`. It builds what is checked out and
does not pull.

**The address the apps carry** is this machine's network address unless the script is told another:
`-Server <name>` / `--server <name>`, where the name is this machine's own (`WKS-01`, `WKS-01.local`), builds
the same way and puts the name in the apps instead. Whichever it is, it has to stay: an app cannot be told a new
address, and a new address on this machine is also a new certificate, so every app would have to be handed out
again. A reserved address in the router (a DHCP reservation) or a name that resolves on the network keeps it.

Without the apps, the floor can also be looked at in a browser: `node harness/run.mjs all` builds the client,
runs the floor and opens the browser where it is. Two things on the first visit: accept the server's own
certificate (one click per machine), and click once in the page — a browser hands out neither microphone nor
sound without a gesture. Headphones, because an open microphone next to a loudspeaker is a loop.

Port **8787/TCP** has to be reachable: the server listens on every interface, and on Windows the firewall asks
once or wants an inbound rule. Voice runs directly between the
clients over UDP — no STUN, no TURN, nothing through the server — so separate VLANs, client isolation on a
wireless network or a VPN can let figures move while nobody is heard.

### The certificate and the names in it

The server issues its own into `.office-mumble/` the first time it starts and reuses it while it fits this
machine (`docs/tls.md` says when it does not). To stop being asked,
download it once per machine and import it as a trusted root:

```
https://<that machine>:8787/cert.pem
```

There is no unencrypted port to fall back to: a client that would accept any certificate is not one this
project ships. One click per machine is the price of taking that seriously from the first day.

**It carries the names it was issued for**: `localhost`, the machine's own name (`/etc/hostname` on Linux,
`COMPUTERNAME` on Windows), the address of the route to the internet, and whatever `--names` adds. On a network
with no default route that address is not found, so `--names` is what names the machine there:

```sh
node harness/run.mjs server --names MYPC,mypc.example.local,192.168.1.20
```

A certificate that lacks one of these names is issued anew on the next start, so changing `--names` takes effect
by restarting. The printed address is a guess (the first interface found); the names in the certificate are what
count.

**The key is the private half and stays that way.** Unix writes it with mode 600. Windows has no mode bits, so
the inherited permissions are cut and the file is given to the account the server runs under and to `SYSTEM`,
with `icacls`. If that fails the server says so in the console instead of carrying on quietly — a key other
accounts of that machine can read is not private.

### The plan on disk

The plan is `fixtures/floor-t1.json` unless `OFFICE_MUMBLE_PLAN` names another; it is read once, as the seed.
Everything built or moved is written back beside it as `fixtures/floor-t1.plan.json` (`OFFICE_MUMBLE_SAVE`), and
**that** file is what the next start reads — so an evening of moving desks and cutting windows survives a
restart. Delete it to fall back to the seed. It is git-ignored on purpose: the seed is the source, a run's plan
is not.

*Export* in the build sidebar downloads that plan as a file; *Import* reads one back through the server, which
checks it like any plan and only from whoever holds the build lock. Anybody standing on a floor the imported
plan no longer has comes down to the ground floor.

### Test figures that speak

Walking figures need nothing. A figure that *speaks* is the colleague program, and it carries Opus:

```sh
cargo build -p office-mumble-colleague
```

That builds a vendored Opus as a static library, so the binary owes nothing to the machine it runs on. The one
thing to install, once, is what Opus's own build script wants — autotools:

```sh
macOS           brew install autoconf automake libtool
Debian/Ubuntu   sudo apt install autoconf automake libtool
```

Or link a system Opus instead of building one — quicker, at the price of an install per machine:

```sh
macOS           brew install opus pkg-config
Debian/Ubuntu   sudo apt install libopus-dev pkg-config
```

The server, the client and the walking figures carry no codec at all, which is why the floor can be walked on a
machine where this one build fails.

The demo figure in the sidebar is the same program, started by the server and handed the server's own
certificate. Its process is watched: when it ends, the figure is taken off the floor at once, and on Linux the
kernel ends it with the server, so no colleague is left running behind a closed door.
`OFFICE_MUMBLE_DEMO_VOICE=werbung.wav` (and `OFFICE_MUMBLE_DEMO_NAME`) say what it is called and what it speaks;
a server without a recording says so instead of offering a button that would fail.

### The harness

`harness/recipes/steps/sheet-build.sh` builds the harness pages into `harness/dist`, which the server hands out at `/dummy/`, apart
from the client's own build. `harness/dev.sh` is the floor and the app on this machine, both fresh; `node harness/run.mjs` is the harness
runner underneath it.

## The colleagues' apps

`client/src-tauri` is a Tauri v2 shell around the same client, and the better client for a daily user: present
means connected, awake and unlocked, and a browser tab cannot see the screen lock while the app can. Lock the
screen or let the machine sleep and you leave the office; unlock it and you arrive again under the same name
and figure. The tray icon says which of the two you are and brings the window back. Closing the window ends the
app.

The app is built for one house: the server's address and its certificate are baked in, so a colleague is handed
one installer, starts it, and is in the office under the name their system knows them by — nothing to type, no
certificate to accept, nothing to build.

### Making them

`office` makes them (see *The server*). An app is built on the platform it is for — Tauri packs the installer of
the machine it runs on, and a Mac app only on a Mac:

| The server runs on | The Windows installer | The Mac app |
|---|---|---|
| Windows | `harness\office.cmd` there | `harness/office.sh --server <server>` on a Mac |
| macOS | `harness\office.cmd -Server <server>` on a Windows machine | `harness/office.sh` there |
| Linux | `harness\office.cmd -Server <server>` on a Windows machine | `harness/office.sh --server <server>` on a Mac |

With a server named, the building machine asks that running server for its certificate, so it has to be up and
reachable from there. Either way the script reads back the certificate and the address inside the app before it
hands anything out. The installers land in `handout/`: an `…_x64-setup.exe` for Windows, a `.dmg` for macOS. They
are made and handed out again when the server's address or certificate changes, or when the app itself has
changed.

Many mail systems refuse an `.exe` attachment, some even inside a `.zip`; a shared folder or a chat upload
carries it.

### On a colleague's Windows machine

Run the setup file. It is not signed, so Windows asks once: *More info*, then *Run anyway*. It installs for the
current user, without administrator rights, under `%LOCALAPPDATA%\office-mumble` with an entry in the Start menu.
A newer installer is run the same way, over the old one.

### On a colleague's Mac

Open the disk image and drag the app into *Applications*. It is not signed, so macOS refuses the first start:
try to open it once, then *System Settings → Privacy & Security → Open Anyway* (on older macOS: right-click the
app, *Open*).

macOS also asks before a program may reach an address on the local network, and an app without a signature may
never be granted it: it then says *No route to host* while a browser on the same Mac reaches the office. The way
out, from macOS 15.5 (Apple's TN3179), is to take the office's network out of that gate — once per Mac, then
restart. With the server at `192.168.1.20`:

```sh
sudo defaults write com.apple.network.local-network AllowedEthernetLocalNetworkAddresses -array "192.168.1.0/24"
sudo defaults write com.apple.network.local-network AllowedWiFiLocalNetworkAddresses -array "192.168.1.0/24"
```

## If something does not work

| What you see | What it is |
|---|---|
| `ERR_CERT_AUTHORITY_INVALID` | the certificate is not trusted yet — accept it, or import `cert.pem` |
| the page loads, nothing connects | the shell trusts a certificate that is not the server's; the status bar names both fingerprints — the app was built for another certificate and has to be made and handed out again |
| the Mac app says *No route to host*, a browser on that Mac works | macOS's local-network gate — see *On a colleague's Mac* |
| figures move, nobody is heard | UDP between the clients is blocked, or both are behind client isolation |
| a speaking figure says none was built | build the colleague (`cargo build -p office-mumble-colleague`) |
| `No space left on device` during a build | Rust build trees are large; check `df -h /` before a long build |
| the microphone is never found | the page was not clicked yet — no gesture, no microphone |
