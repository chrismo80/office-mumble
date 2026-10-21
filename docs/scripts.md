# The scripts

Every script is one thing. They come in two layers inside `harness/recipes`: a recipe says *what* and in which
order, a step does it. A step belongs to the recipes — nothing outside that folder uses one except the harness
runner, which builds the sheet the same way the recipes do. That means a step can be run alone, and a failure
names the step it happened in.

All of them are silent on success and say what they did in one line where it matters. None needs a parameter.

## Steps — `harness/recipes/steps/`

One action each. No order, no decisions.

| Script | What it does |
| --- | --- |
| `server-build` | Builds the floor server, release. Does not start it. |
| `server-start` | Starts it in the background with a log and a pid file, waits until HTTPS answers. Refuses a second one, asked of the port — a floor started by hand has no pid file. Repeats the server's lines when it issued a new certificate. |
| `server-stop` | Stops it: by pid file, else whoever holds the port, together with the processes it started. Kills nothing else. |
| `server-status` | Port, pid, since when, and whether HTTPS answers. Exit 1 when nothing listens. |
| `server-address` | Prints which office the app is for, and remembers a named one — see *Which office* below. |
| `cert-renew` | Removes the certificate pair, so the floor issues a new one on its next start. Says so when a running floor still uses the old one. |
| `web-build` | The browser client: type check and bundle into `client/dist`. |
| `sheet-build` | The art sheet into `harness/dist`, which the server hands out at `/dummy/`. |
| `app-build` | Packs the desktop app for this platform, certificate included. Prints where the bundle is. `--app-only` / `-AppOnly` leaves the installer out: on macOS it builds the `.app`, elsewhere the bare executable. |

They are the leaf: nothing below them, and they call no other step.

Every one of them exists twice: `.sh` for Linux and macOS, `.ps1` for Windows. Two helpers sit beside them:
`net.sh`, sourced by the shell steps, and `lan-address.mjs`, which both kinds run for this machine's address.

`web-build` and `sheet-build` run corepack from inside `client/`. corepack picks the pnpm version from the
`package.json` of the folder it runs in; from the repository root, which has none, it fetches the newest pnpm,
and that refuses the version the client names. An older corepack — the one in Node 22.11 — cannot verify the
signature of pnpm 9.15.9 at all; a current Node 22 can.

## Recipes — `harness/recipes/`

One intention each, made of steps.

| Recipe | What it calls | When |
| --- | --- | --- |
| `build` | `server-build`, `web-build`, `sheet-build`, and `app-build` when `OFFICE_MUMBLE_SERVER` is set | Everything this machine can build |
| `serve` | `server-build`, `web-build`, `server-start` | Look at it in the browser |
| `restart` | `server-stop`, `server-build`, `server-start` | After changing the server |
| `local` | `restart`, `start-app` | The app: floor and app both fresh and running (`dev.sh` is its name) |
| `start-app` | `app-build`, then starts the app | Only the app |
| `pack-app` | `web-build`, `app-build` | The bundle, nothing installed or started |
| `office` | `web-build`; on the server's machine `server-stop`, `server-build`, `server-start`; then its own installer build | The server and the colleagues' installer — see below |

`build` packs the app only when the environment names an office, because a full Tauri build is minutes long and
`build` should stay the quick one. The app recipes ask for the address themselves.

## Entry points — `harness/`

`harness/` holds the entry points and nothing else: each is a name for one recipe, `.sh` on macOS and Linux and
`.cmd` on Windows. The `.cmd` is there because a double click starts it, and because it runs the recipe's
`.ps1` with `-ExecutionPolicy Bypass` for that run only — a Windows that was never told otherwise refuses `.ps1`
files. Every `.cmd` passes its arguments on, waits for a key before its window closes, and ends with the
recipe's exit code.

| Script | What it is |
| --- | --- |
| `make.sh` / `make.cmd` | A name for `recipes/build`. `--no-app` / `-NoApp` leaves the app out. |
| `dev.sh` / `dev.cmd` | The floor and the app on this machine, both fresh and running — the name for `recipes/local`. The app is started out of the build folder, not installed. With a word after it, it goes to the harness runner instead: `dev.sh walkers --count 4`. |
| `office.sh` / `office.cmd` | A name for `recipes/office`: the office, ready to hand out. Without an argument, on the server's machine: installs what the build needs, builds and starts the server, builds this platform's installer for it, reads back the certificate and the address inside the app, and leaves the installer in `handout/`. With `-Server <host>` / `--server <host>` it builds the installer for a server already running elsewhere, with the certificate that server shows; a `<host>` that is this machine builds the server too and puts that name in the app. Builds what is checked out, never pulls. Linux builds the server and no app. `docs/setup.md` has the whole way. |

The two to know are `dev` — see a change, server or client, on this machine — and `office` — the server and the
colleagues' installers. The recipes and steps are what they are made of.

`harness/run.mjs` is the harness runner, not a build script: `server`, `all`, `test`, `verify`, `client`, `open`,
`dummy`, `walkers`, `colleague`. `dev.sh` hands a word after it to the runner.

## Which office

The app recipes (`app-build`, `start-app`, `pack-app`) never ask; `office` is told, or builds for this machine. `server-address` answers, in
this order:

1. `OFFICE_MUMBLE_SERVER`, if set — a bare host, or `host:port`
2. the office named last time, kept in `.office-mumble/server`
3. this machine, by its network address (`192.168.38.117:8787`) — said out loud; `localhost` would only reach
   a floor on whatever machine the app happens to run on

Only a named office is written back, so a machine that built once for a house never has to say it again. This
machine's address is worked out anew on every run, because it is the address that changes — a new lease from
the router, another network — and a remembered one would go on building apps for an address the machine no
longer has. `.office-mumble/` is git-ignored: the certificate and this note stay with the machine.

The address is the one the system would leave the network by (`lan-address.mjs`): cable or Wi-Fi, whatever
the adapter is called, and never a WSL, Hyper-V or Docker adapter, which are not on that route. It is the rule
the server uses for the address in its certificate, so the app and the certificate it pins name the same address.

The address is baked into the app, so `localhost` means "a server on the machine the app runs on" — right for a
dev build, useless to a colleague. `app-build` says so when it builds one, and names the alternative:
`OFFICE_MUMBLE_SERVER=<this machine's LAN address>`. The server itself always listens on `0.0.0.0`, so it is
reachable from the network either way; it is the app's address that decides who can talk to it.

## What needs what

- **A running server** — only `app-build`, and only for the certificate the app pins. The fetch lands in
  `.office-mumble/pinned.pem`, never in `cert.pem`: on the machine that hosts the server, `cert.pem` is one half
  of the pair with `key.pem`, and a foreign certificate there stops the floor from starting. `build.rs` reads
  `pinned.pem` first and `cert.pem` second. The fetch is atomic — a temporary file and one move. When the office
  does not answer: if it is this machine, its own `cert.pem` is pinned and a stale `pinned.pem` removed; if it is
  another, the one already pinned is used with a warning; with none at all, it stops with the reason. A server
  key on the building machine does not decide it — a machine with a test floor of its own still pins the office
  it builds for. `OFFICE_MUMBLE_CERT=<file>` overrides all of it. `office` is stricter: it always asks the
  running server and stops when it does not answer, because what it builds is handed out.
- **The machine that hosts the server** is the only one that can run `serve`, `restart`, `local` or `dev.sh`,
  because those start a server. The certificate is the server's own business — when it is issued anew, and why,
  is in `docs/tls.md`; `server-start` only repeats what the server said. `server-stop` ends the server's own
  children with it: the demo colleague outlives its server on Windows and macOS, where nothing ends a child with
  its parent, and goes on holding the server's log open, so the next start cannot write it and stops at once.
  On a build machine, the work is `start-app`, `pack-app` and `office` with a server named.
- **Node and pnpm** — the client and the sheet. `pnpm` comes through `corepack`, so no global install.
- **Rust and the Tauri CLI** — `app-build`. `office` installs them when missing, on Windows and macOS.
- Everything else needs nothing but the toolchain that builds the server.

## Platforms

- `.sh` runs on Linux and macOS; `.ps1` on Windows.
- `app-build` packs the app of the machine it runs on. Tauri does not cross-compile: a Linux machine cannot make
  the Windows installer, and a Mac cannot make the MSI.
- `server-status` and `server-stop` on Windows use `Get-NetTCPConnection`, so they are Windows-only by nature.
  Starting, and asking whether a floor answers, use `curl.exe` there for the same question the shell scripts ask:
  not "is the port taken" but "does it answer HTTPS with a certificate". `Invoke-WebRequest` cannot skip the
  certificate check in Windows PowerShell 5.1.
- The `.ps1` scripts are written for Windows PowerShell 5.1, the one the `.cmd` entry points start, and they carry a UTF-8
  byte order mark: without one, 5.1 reads a file in the ANSI code page, and the third byte of a `—` becomes a
  quotation mark that ends a string in the middle. Every one of them ends with an `exit`, because the caller reads
  `$LASTEXITCODE`, and a script that ends without one leaves whatever ran before it — nothing at all in a fresh
  PowerShell, which a caller reads as a failure and passes on as success.
- `server-start.ps1` starts the floor through `cmd`, which writes the logs. A `Start-Process` with
  `-RedirectStandardOutput` hands the server every inheritable handle, so whoever captures the script's output — an
  IDE task, CI — would wait until the server ends.
- `.gitattributes` keeps `.sh` files at LF in every checkout, Windows included: `sh` reads a CR as part of the
  line. It keeps `.cmd` files at CRLF everywhere, because `cmd` misreads labels and blocks in a file with LF.
- On macOS and Linux the shell scripts ask through `harness/recipes/steps/net.sh`: `lsof` where it exists, `ss`
  where it does not, `curl` for "does it answer" because that is the question a client cares about.
- Linux builds no installer: `office.sh` there builds and starts the server and names the commands that make the
  apps on a Mac and on Windows.
