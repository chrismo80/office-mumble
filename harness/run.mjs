#!/usr/bin/env node
// The harness: the one way to start the office and to watch it.
//
//   node harness/run.mjs <command> [flags]
//
// A tool, not a deliverable. No build step and no dependencies, and this is where scenarios grow —
// more walkers, other plans, other names — without anybody having to learn a new command line.
//
// ── the scenarios, as templates to copy ─────────────────────────────────────────────────────────────
// For the one most people want: `node harness/run.mjs test` — the floor, the browser, and Ada and Bob
// walking and talking, one recording each, until Ctrl-C. The list below is the pieces it is made of.
//
// Server and clients on this machine, one terminal per command, no network needed. `--local` is what
// keeps it here: the walkers and the colleague otherwise dial the LAN address they find, which is the
// wrong door as soon as the office is not listening on it.
//
//   1. Alone in the office. One figure is the whole picture: `all` starts the server and *one* browser.
//        node harness/run.mjs all
//
//   2. Somebody to look at. Three figures that keep moving, in a second terminal:
//        node harness/run.mjs walkers --count 3 --names Ada,Bob,Cid --dwell 4 --local
//      `--once` has each of them stop once and leave instead of wandering on. Walkers move and nothing
//      else: they carry no voice in either direction and know no --voice, so a floor full of walkers is
//      a silent one. Figures that speak are colleagues — scenario 4 and 5.
//
//   3. A second real client. Another window, another figure, and a microphone on the far end:
//        node harness/run.mjs open --host localhost --name Zweite
//      or open https://localhost:8787/?name=Zweite yourself: two windows are two people.
//
//   4. A colleague with a voice and no window — the hearing rule, and something to listen to. It speaks
//      a generated tone, or a recording when one is named:
//        node harness/run.mjs colleague --name Rusty --seconds 60 --at 5.25,2.25 --local
//        node harness/run.mjs colleague --name Rusty --seconds 60 --voice a-recording.wav --local
//      Walk over and click the door: the status bar's `hörbar` line falls to `niemanden`, and Rusty's
//      log says it let the link go. Open the door again and both come back. `--walk x,y@seconds` and
//      `--door row,col@seconds` make it move and work doors on its own, so a run needs no hands.
//
//   5. Two colleagues, two voices — your own recordings, one per person, walking as well as speaking. One
//      terminal each, long enough to walk over:
//        node harness/run.mjs colleague --name Ada --seconds 300 --voice ada.wav --local --walk 21.25,9.25@15 --walk 8.25,1.25@70
//        node harness/run.mjs colleague --name Bob --seconds 300 --voice bob.wav --local --walk 20.25,1.75@30 --walk 9.25,7.75@80
//      That is the README's Ada and Bob — the names scenario 2 gives the walkers — with a voice each. Without
//      `--voice` a colleague speaks a generated tone: enough to hear the rule, not enough to tell two apart.
//      The walkers themselves have none, and their figures never wear the speaking ring.
//
//   6. A voice in a browser tab, when a second person is not there:
//        node harness/run.mjs dummy --host localhost --source bursts --name Dummy
//      source=file reads a recording beside the page, bursts is syllables with pauses, tone is
//      continuous, silence connects and sends nothing, and ?voice=<file> reads a recording of yours.
//
//   7. The four places, in the browser, no second terminal: the rail's Büro, Bauen, Du, Einstellungen,
//      and ⌘K for the palette. Bauen is the only place that may change the floor and the office holds
//      no control that can; Du is a draft until *Übernehmen*.
//
//   8. What a branch claims, with numbers. Brings up a floor of its own on 8899 and exits non-zero if
//      any check fails:
//        node harness/run.mjs verify
//
//   9. The tests alone:
//        cargo test --workspace      the plan, the way through it, the rules
//        cd client && pnpm test      the places, who may change what, the palette's rows
//
// Nothing is heard until the page has been clicked once, which is the browser's own rule and not ours.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { connect } from 'node:net';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(root, 'client');
const DEFAULT_PORT = 8787;
const DEFAULT_DEV_PORT = 5173;
// `verify` runs a floor of its own so it never disturbs one that is already up.
const DEFAULT_VERIFY_PORT = 8899;
const DEFAULT_NAMES = ['Ada', 'Bob', 'Cid', 'Dee', 'Eli', 'Fay', 'Gil', 'Hana'];

// ── the argument surface ────────────────────────────────────────────────────
// A plain parser on purpose: a new flag is one line here and nothing else has to change.
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) flags[key] = true;
      else {
        // A flag given twice becomes a list instead of the last one winning: `--walk a --walk b` is two
        // walks, and every existing flag keeps behaving exactly as it did with one value.
        if (flags[key] === undefined) flags[key] = value;
        else if (Array.isArray(flags[key])) flags[key].push(value);
        else flags[key] = [flags[key], value];
        i += 1;
      }
    } else rest.push(token);
  }
  return { flags, rest };
}

// ── small helpers ───────────────────────────────────────────────────────────
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

const pageUrl = (host, port, name) =>
  `https://${host}:${port}/${name ? `?name=${encodeURIComponent(name)}` : ''}`;
const socketUrl = (host, port) => `wss://${host}:${port}/ws`;

/**
 * pnpm, or the one corepack hands out where pnpm itself is not installed. Node ships corepack, so a machine
 * with Node needs nothing more to build the client — and `corepack enable` is not asked for, because on
 * Windows it writes into the Node installation and wants an administrator for that.
 */
const PNPM = (() => {
  if (spawnSync('pnpm --version', { shell: true, stdio: 'ignore' }).status === 0) return 'pnpm';
  // Without this, corepack stops to ask before it fetches pnpm the first time, and nobody sees the question.
  process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  return 'corepack pnpm';
})();

function shell(line, options = {}) {
  console.log(`  $ ${line}`);
  return spawn(line, { stdio: 'inherit', shell: true, cwd: root, ...options });
}

function shellOnce(line, options) {
  return new Promise((done, failed) => {
    const child = shell(line, options);
    child.on('exit', code => (code === 0 ? done() : failed(new Error(`\`${line}\` exited with ${code}`))));
  });
}

/** Is anything listening? A plain TCP handshake, so no certificate has to be trusted to ask. */
function waitForPort(port, host = '127.0.0.1', timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done, failed) => {
    const attempt = () => {
      const socket = connect({ port, host });
      socket.once('connect', () => { socket.destroy(); done(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) failed(new Error(`nothing listening on ${host}:${port}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function openBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  console.log(`  opening ${url}`);
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

// ── the one thing only the voices need ──────────────────────────────────────
// The colleague is Rust and links Opus; the floor, the browser client and the walkers are not and do not.
// That asymmetry is why a machine can walk the office happily and still fail the moment a voice is asked
// for — and why the failure is worth naming, because without pkg-config the vendored Opus tries to build
// itself and wants autoconf, so what arrives is a page of build output that never says what to install.
const VOICES_NEED_OPUS = [
  '',
  '  the voices are Rust colleagues, and Opus is not built here — the floor and the browser client need',
  '  none of it, which is why the office is already up:',
  '',
  '    the vendored Opus, built once and carried in the binary (what the design intends):',
  '      macOS    brew install autoconf automake libtool',
  '',
  '    or link a system Opus instead of building one:',
  '      macOS          brew install opus pkg-config',
  '      Debian/Ubuntu  sudo apt install libopus-dev pkg-config',
  '',
];
const isOpusTrouble = said =>
  /audiopus|Failed to autogen Opus|could not find Opus|autoreconf|opus\.pc/i.test(said);

/** Builds the voices once, out loud, so a machine without Opus hears it said once instead of twice. */
async function buildVoices() {
  const child = spawn('cargo build -p office-mumble-colleague', {
    stdio: ['ignore', 'pipe', 'pipe'], shell: true, cwd: root,
  });
  let said = '';
  child.stdout.on('data', chunk => { said += chunk; });
  child.stderr.on('data', chunk => { said += chunk; });
  const code = await new Promise(done => child.on('exit', done));
  return { code, said };
}

async function ensureInstalled() {
  if (existsSync(join(clientDir, 'node_modules'))) return;
  console.log('the client has no dependencies yet — installing them');
  await shellOnce(`${PNPM} install`, { cwd: clientDir });
}

async function ensureBuilt() {
  await ensureInstalled();
  if (existsSync(join(clientDir, 'dist', 'index.html'))) return;
  console.log('the client is not built yet — building it');
  await shellOnce(`${PNPM} build`, { cwd: clientDir });
}

// ── server ──────────────────────────────────────────────────────────────────
async function cmdServer(flags) {
  const port = Number(flags.port ?? DEFAULT_PORT);
  const host = flags.host ?? lanAddress();
  const name = flags.name ?? 'Guest';
  if (!flags['no-build']) await ensureBuilt();

  console.log('\nthe floor is at');
  console.log(`  ${pageUrl(host, port, name)}   ← any machine on the network`);
  console.log(`  ${pageUrl('localhost', port, name)}   ← this one`);
  console.log(`  socket ${socketUrl(host, port)}`);
  console.log(`  certificate, to install once per machine: https://${host}:${port}/cert.pem\n`);

  const env = {
    ...process.env,
    OFFICE_MUMBLE_PORT: String(port),
    OFFICE_MUMBLE_PLAN: String(flags.plan ?? 'fixtures/floor-t1.json'),
    OFFICE_MUMBLE_CERT_DIR: String(flags['cert-dir'] ?? '.office-mumble'),
  };
  if (flags.names) env.OFFICE_MUMBLE_NAMES = String(flags.names);

  const child = shell('cargo run -p office-mumble-server', { env, detached: flags.detached === true });
  if (flags.open) waitForPort(port).then(() => openBrowser(pageUrl(host, port, name))).catch(() => {});
  return child;
}

// ── client, with hot reload ─────────────────────────────────────────────────
async function cmdClient(flags) {
  const port = Number(flags.port ?? DEFAULT_DEV_PORT);
  const server = String(flags.server ?? socketUrl(flags.local ? 'localhost' : lanAddress(), flags['server-port'] ?? DEFAULT_PORT));
  const name = String(flags.name ?? 'Guest');
  await ensureInstalled();

  const url = `http://localhost:${port}/?server=${encodeURIComponent(server)}&name=${encodeURIComponent(name)}`;
  console.log('\nthe development client will be at');
  console.log(`  ${url}`);
  console.log(`  talking to ${server}`);
  const localCert = join(root, '.office-mumble', 'cert.pem');
  if (existsSync(localCert)) {
    console.log('  if it stays "disconnected", the browser does not trust the server yet: install');
    console.log(`  ${localCert} once, or fetch it from https://${new URL(server).host}/cert.pem\n`);
  } else {
    console.log(`  if it stays "disconnected", install the server certificate from https://${new URL(server).host}/cert.pem\n`);
  }

  const child = shell(port === DEFAULT_DEV_PORT ? `${PNPM} dev` : `${PNPM} dev --port ${port}`, { cwd: clientDir });
  if (!flags['no-open']) waitForPort(port).then(() => openBrowser(url)).catch(() => {});
  return child;
}

// ── just open what is already running ───────────────────────────────────────
async function cmdOpen(flags) {
  const port = Number(flags.port ?? DEFAULT_PORT);
  const host = String(flags.host ?? lanAddress());
  const url = String(flags.url ?? pageUrl(host, port, flags.name ?? 'Guest'));
  openBrowser(url);
}

// ── a colleague who can be heard, so a floor needs nobody else ──────────────
async function cmdDummy(flags) {
  const port = Number(flags.port ?? DEFAULT_PORT);
  const host = String(flags.host ?? lanAddress());
  const name = String(flags.name ?? 'Dummy');
  const source = String(flags.source ?? 'file');
  const voice = flags.voice ? `&voice=${encodeURIComponent(String(flags.voice))}` : '';
  if (!flags['no-build']) {
    // Windows has no sh: there the same step is the PowerShell one beside it.
    await shellOnce(
      process.platform === 'win32'
        ? 'powershell -NoProfile -ExecutionPolicy Bypass -File harness/recipes/steps/sheet-build.ps1'
        : 'sh harness/recipes/steps/sheet-build.sh',
    );
  }

  const url = `https://${host}:${port}/dummy/?name=${encodeURIComponent(name)}&source=${encodeURIComponent(source)}${voice}`;
  console.log('\na synthetic colleague is at');
  console.log(`  ${url}`);
  console.log('  leave the tab open and walk over in your own page: it is a voice, not a person');
  console.log('  source=bursts syllables with pauses · source=tone continuous · source=silence nothing to send\n');
  if (!flags['no-open']) openBrowser(url);
}

// ── a colleague with no window: the rule and voice, without a browser ───────
async function cmdColleague(flags) {
  const port = Number(flags.port ?? DEFAULT_PORT);
  const host = String(flags.host ?? (flags.local ? 'localhost' : lanAddress()));
  const server = String(flags.server ?? socketUrl(host, flags['server-port'] ?? port));
  const name = String(flags.name ?? 'Rusty');
  const seconds = String(flags.seconds ?? 30);
  // The office's own public half, the same one the walkers are given: a colleague that accepted any
  // certificate would be testing something other than what a person runs.
  const cert = await certificateFor(server, flags.cert);

  const list = value => [].concat(value ?? []).filter(entry => entry !== true).map(String);
  const parts = [
    'cargo run -p office-mumble-colleague --',
    `--name ${name}`,
    `--seconds ${seconds}`,
    `--server ${server}`,
    `--cert ${cert}`,
  ];
  if (flags.voice) parts.push(`--voice ${flags.voice}`);
  if (flags.at) parts.push(`--at ${flags.at}`);
  for (const walk of list(flags.walk)) parts.push(`--walk ${walk}`);
  for (const door of list(flags.door)) parts.push(`--door ${door}`);

  console.log('\na colleague with no window joins the floor');
  console.log(`  ${name}, for ${seconds} s, talking to ${server}`);
  console.log('  it obeys the same hearing rule as the browser client: one connection per person it can hear,');
  console.log('  real Opus in both directions, and a summary every second\n');
  return shellOnce(parts.join(' '));
}

// ── the whole stand in one command: the floor, and two voices that walk ──────
// What a person wants when they want to *hear* the rule rather than read it. `test` starts the floor the
// way `all` does, and then puts Ada and Bob on it — the two names the walkers get — each speaking one of
// the two recordings this repository carries, in a loop, on a tour of the floor, so the voice comes near
// and goes far by itself and the hearing rule has something to do. Ctrl-C ends the whole stand.
async function cmdTest(flags) {
  const port = Number(flags.port ?? DEFAULT_PORT);
  const planPath = String(flags.plan ?? 'fixtures/floor-t1.json');
  const names = String(flags.names ?? 'Ada,Bob').split(',').map(n => n.trim()).filter(Boolean);
  // No default recordings: this repository carries none, so a voice that was not named speaks a generated tone.
  const voices = String(flags.voice ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const seconds = Number(flags.seconds ?? 3600);
  // One stop every half minute or so, and never so many that the command line gets silly.
  const hops = Math.min(Number(flags.hops ?? 120), Math.max(1, Math.floor(seconds / 15)));

  // The floor first, exactly as `all` starts it: the server here, and the browser on this machine.
  // Detached, so it leads a process group of its own: `cargo run` puts two processes between this script
  // and the floor, and killing only the first of them would leave the server running and the port taken.
  const server = await cmdServer({
    port: flags.port,
    host: flags.host,
    plan: flags.plan,
    name: flags.name,
    'cert-dir': flags['cert-dir'],
    'no-build': flags['no-build'],
    detached: true,
    open: !flags['no-open'],
  });
  await waitForPort(port);

  // The voices are colleagues, not walkers: the walkers carry no audio at all, so a talking figure is a
  // colleague with a `--voice`. Both are on this machine as the server is, so they talk over the loop.
  const socket = socketUrl('localhost', port);
  const cert = await certificateFor(socket, flags.cert);

  // Where they walk comes from the plan itself, because a tour of the floor is only a tour if the cells
  // are real — the same list of standing places the walkers choose from.
  const cells = walkableCells({ plan: JSON.parse(readFileSync(join(root, planPath), 'utf8')) });
  if (cells.length === 0) throw new Error(`${planPath} has no floor to stand on`);

  // The voices are a Rust build with one requirement of its own, so it is asked for once, here, before
  // two of them each say it in cargo's own long-winded way. If it fails, the floor stays up: a person can
  // still walk it, and the thing to install is printed where they will see it.
  process.stdout.write('  building the voices… ');
  const built = await buildVoices();
  if (built.code !== 0) {
    console.log('no.');
    console.log(isOpusTrouble(built.said) ? VOICES_NEED_OPUS.join('\n')
      : `${built.said.trim().split('\n').slice(-10).join('\n')}\n`);
    console.log('  the floor stays up — walk around, install what is missing, and run test again\n');
    return server;
  }
  console.log('done.\n');

  console.log(`\n  ${names.length} voices on the floor, each walking and talking for ${seconds} s:`);
  for (const [i, name] of names.entries()) {
    const speaks = voices.length ? voices[i % voices.length] : 'a generated tone';
    console.log(`    ${name} speaks ${speaks}, ${hops} stops`);
  }
  console.log('  walk over and listen; work a door and the voice goes; Ctrl-C ends the stand\n');

  const running = [];
  let stopping = false;
  // Each child leads a process group of its own — `cargo run` again — so the whole little tree goes at
  // once instead of the wrapper alone, which is how a stand leaks a server and a voice that will not die.
  const killTree = (child, signal) => {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
  };
  const stopAll = () => {
    if (stopping) return;
    stopping = true;
    for (const child of running) killTree(child, 'SIGTERM');
    killTree(server, 'SIGINT');
    setTimeout(() => process.exit(0), 500).unref?.();
  };
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);

  names.forEach((name, i) => {
    const voice = voices.length ? voices[i % voices.length] : null;
    // A tour rather than a wander: each stop as far as possible from the one before, so the voice crosses
    // the floor instead of shuffling in a corner, and the fade in and out is something you can hear.
    const tour = tourOf(cells, hops + 1).slice(1);
    const walks = tour.map(([x, y], k) =>
      `--walk ${x.toFixed(2)},${y.toFixed(2)}@${Math.round(((k + 1) * seconds) / (tour.length + 1))}`);
    // Staggered, so the two do not race for cargo's build lock and their summaries do not land together.
    setTimeout(() => {
      if (stopping) return;
      const line = `cargo run -p office-mumble-colleague -- --name ${name} --seconds ${seconds}`
        + ` --server ${socket} --cert ${cert}${voice ? ` --voice ${voice}` : ''} ${walks.join(' ')}`;
      const child = spawn(line, { stdio: ['ignore', 'pipe', 'pipe'], shell: true, cwd: root, detached: true });
      running.push(child);
      const say = chunk => {
        for (const each of String(chunk).split('\n')) {
          if (each.trim()) console.log(`  ${name} │ ${each.trimEnd()}`);
        }
      };
      child.stdout.on('data', say);
      child.stderr.on('data', say);
      child.on('exit', code => {
        if (stopping) return;
        console.log(`  ${name} └─ left after ${seconds} s (exit ${code}); the floor stays up — run test again for another pass`);
      });
    }, i * 1500);
  });

  return server;
}

/** A tour of the floor: every stop as far as possible from the one before, so a voice comes and goes. */
function tourOf(cells, stops) {
  const left = cells.slice();
  const tour = [left.splice(Math.floor(Math.random() * left.length), 1)[0]];
  while (tour.length < stops && left.length > 0) {
    const [lx, ly] = tour[tour.length - 1];
    let best = 0;
    let furthest = -1;
    left.forEach((cell, i) => {
      const away = Math.hypot(cell[0] - lx, cell[1] - ly);
      if (away > furthest) { furthest = away; best = i; }
    });
    tour.push(left.splice(best, 1)[0]);
  }
  return tour;
}

// ── verify: what a pull request claims, checked on this machine ─────────────
// The numbers are the point. A check passes because packets arrived, decodes landed on 20 ms frames and two
// sides agree on their own counters — not because a line said "connected".
function capture(line, options = {}) {
  return new Promise(done => {
    const child = spawn(line, { cwd: root, shell: true, ...options });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('error', error => done({ code: 1, out: `${out}\n${error.message}` }));
    child.on('exit', code => done({ code: code ?? 1, out }));
  });
}

// Every line a colleague prints about a link, in one shape. The second it was printed at matters: comparing one
// colleague's total against the other's half-finished line says nothing about the wire.
const LINK_LINE =
  /^\s*(TOTAL|\s*t)\s+([\d.]+)s\s+#(\d+)\s+level\s+([\d.]+)\s+up (true|false)\s+sent (\d+) pkt \/ (\d+) B\s+got (\d+) pkt \/ (\d+) B\s+decoded (\d+) x (\d+)\s+odd (\d+)\s+bad (\d+)/gm;

function linksIn(out) {
  const rows = [];
  for (const hit of out.matchAll(LINK_LINE)) {
    rows.push({
      total: hit[1].trim() === 'TOTAL',
      at: Number(hit[2]), id: Number(hit[3]), level: Number(hit[4]), up: hit[5] === 'true',
      sent: Number(hit[6]), sentBytes: Number(hit[7]),
      got: Number(hit[8]), gotBytes: Number(hit[9]),
      decoded: Number(hit[10]), frame: Number(hit[11]),
      odd: Number(hit[12]), bad: Number(hit[13]),
    });
  }
  return rows;
}

const lastLink = out => linksIn(out).at(-1) ?? null;
/** The last line that is not a total, for comparing with a snapshot taken mid-run. */
const lastTimed = out => linksIn(out).filter(row => !row.total).at(-1) ?? null;
const levelsIn = out => linksIn(out).map(row => row.level);

/** What both of them said about each other, at the last second they both reported it. The second is the only
 *  thing the two lines have in common — each names the *other* as its peer, so ids never match — and the newest
 *  common second is the honest place to compare, because a colleague that leaves first prints "no connections"
 *  instead of a total while the other keeps counting. */
function commonRows(one, two) {
  const left = linksIn(one);
  const right = linksIn(two);
  let best = null;
  for (const row of left) {
    for (const other of right) {
      if (row.at !== other.at) continue;
      if (!best || other.at > best[1].at || (other.at === best[1].at && other.total && !best[1].total)) {
        best = [row, other];
      }
    }
  }
  return best ?? [left.at(-1) ?? null, right.at(-1) ?? null];
}

/** A plan file's first floor: its cell rows and the size of a cell, or null if it is not a plan. */
function planFloor(path) {
  try {
    const file = JSON.parse(readFileSync(path, 'utf8'));
    const floor = file.floors?.[0];
    if (!Array.isArray(floor?.cells)) return null;
    return { cells: floor.cells, cellM: Number(file.cell_m ?? 0.5) };
  } catch {
    return null;
  }
}

/** Floor or open door: what a person can stand on, which is what the rule's area is made of. */
const walkableCell = code => code === 'floor' || code === 'doorOpen';
const isDoorCell = code => code === 'doorOpen' || code === 'doorShut';

/**
 * Whether two cells are one area with the door at `door` treated as open or shut — the rule's own
 * flood-fill over floor and open doors, the same membership test `crates/hearing` makes. With the door shut
 * the two are one area only when there is another way round; the whole point of a door is that there is not.
 */
function oneArea(cells, from, to, door, doorOpen) {
  const height = cells.length;
  const width = cells[0]?.length ?? 0;
  const passable = (r, c) => {
    if (r < 0 || c < 0 || r >= height || c >= width) return false;
    if (r === door[0] && c === door[1]) return doorOpen;
    return walkableCell(cells[r][c]);
  };
  if (!passable(from[0], from[1]) || !passable(to[0], to[1])) return false;
  const seen = new Set([from[0] * width + from[1]]);
  const queue = [from];
  while (queue.length > 0) {
    const [r, c] = queue.pop();
    if (r === to[0] && c === to[1]) return true;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr;
      const nc = c + dc;
      if (!passable(nr, nc)) continue;
      const key = nr * width + nc;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push([nr, nc]);
    }
  }
  return false;
}

/**
 * A door that genuinely separates two walkable cells, found rather than trusted: the walls must run along
 * both flanks — or there is a way around and the door separates nothing — and the two cells across it must
 * be one area with the door open and two areas with it shut, which is exactly the cut `crates/hearing`
 * makes. A number that happened to be right once is not a door, so the rule is asked about the cells the
 * door is drawn between, and a door that is only decorative is passed over.
 *
 * The one that is open and nearest the spawn is chosen: the two colleagues have to reach it before it is
 * shut, and an open door starts them in earshot, so a run needs no toggle before it can begin. Returns the
 * count of doors looked at, so a floor with none can say so rather than fail obscurely.
 */
function findDoor(cells) {
  const height = cells.length;
  const width = cells[0]?.length ?? 0;
  const wall = (r, c) => r >= 0 && c >= 0 && r < height && c < width && cells[r][c] === 'wall';
  const open = (r, c) => r >= 0 && c >= 0 && r < height && c < width && walkableCell(cells[r][c]);
  const spawn = (() => {
    for (let r = 0; r < height; r += 1) {
      for (let c = 0; c < width; c += 1) if (walkableCell(cells[r][c])) return [r, c];
    }
    return null;
  })();

  const found = [];
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (!isDoorCell(cells[row][col])) continue;
      // A door in an east-west wall has walls left and right and the way through is up and down; in a
      // north-south wall it is the other way round.
      const across = wall(row, col - 1) && wall(row, col + 1) && open(row - 1, col) && open(row + 1, col)
        ? [[row - 1, col], [row + 1, col]] : null;
      const updown = wall(row - 1, col) && wall(row + 1, col) && open(row, col - 1) && open(row, col + 1)
        ? [[row, col - 1], [row, col + 1]] : null;
      const sides = across ?? updown;
      if (!sides) continue;
      const door = [row, col];
      if (!oneArea(cells, sides[0], sides[1], door, true)) continue; // open: still one area
      if (oneArea(cells, sides[0], sides[1], door, false)) continue; // shut: must be two areas
      const reach = spawn
        ? Math.abs(sides[0][0] - spawn[0]) + Math.abs(sides[0][1] - spawn[1])
          + Math.abs(sides[1][0] - spawn[0]) + Math.abs(sides[1][1] - spawn[1])
        : 0;
      found.push({ row, col, sides, open: cells[row][col] === 'doorOpen', reach });
    }
  }
  found.sort((x, y) => x.reach - y.reach);
  const pick = found.find(candidate => candidate.open) ?? null;
  return {
    door: pick ? { row: pick.row, col: pick.col, a: pick.sides[0], b: pick.sides[1] } : null,
    doors: found.length,
    openDoors: found.filter(candidate => candidate.open).length,
  };
}

/** How far the hearing rule carries a voice at all — `EARSHOT_M` in `crates/hearing`. */
const EARSHOT_M = 8;

/**
 * Where to send a colleague so that they end up out of earshot of somebody standing at the spawn: the
 * nearest place by walking that lies a margin beyond earshot in a straight line. Found on the plan rather
 * than written down, because a number that was right for one floor stands somebody in a wall — or outside
 * the building — on the next; and the nearest such place, because the walk has to fit inside the run with
 * the grace still to wait out after it. Returns metres from the floor's corner, or null for a floor too
 * small to leave earshot in.
 */
function outOfEarshot(cells, cellM, marginM = 2) {
  const height = cells.length;
  const width = cells[0]?.length ?? 0;
  let spawn = null;
  for (let r = 0; r < height && !spawn; r += 1) {
    for (let c = 0; c < width; c += 1) if (walkableCell(cells[r][c])) { spawn = [r, c]; break; }
  }
  if (!spawn) return null;
  const seen = new Set([spawn[0] * width + spawn[1]]);
  const queue = [spawn];
  for (let i = 0; i < queue.length; i += 1) {
    const [r, c] = queue[i];
    if (Math.hypot(r - spawn[0], c - spawn[1]) * cellM >= EARSHOT_M + marginM) {
      return `${((c + 0.5) * cellM).toFixed(2)},${((r + 0.5) * cellM).toFixed(2)}`;
    }
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const [nr, nc] = [r + dr, c + dc];
      if (nr < 0 || nc < 0 || nr >= height || nc >= width || !walkableCell(cells[nr][nc])) continue;
      if (seen.has(nr * width + nc)) continue;
      seen.add(nr * width + nc);
      queue.push([nr, nc]);
    }
  }
  return null;
}

const near = (a, b, tolerance) => Math.abs(a - b) <= Math.max(1, Math.max(a, b) * tolerance);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const tail = text => text.trim().split('\n').slice(-3).join(' | ').slice(0, 220);

/** A port nothing is listening on, so a browser left over from a killed run cannot answer for this one. */
async function freePort(start) {
  for (let candidate = start; candidate < start + 20; candidate++) {
    const taken = await new Promise(done => {
      const socket = connect({ port: candidate, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); done(true); });
      socket.once('error', () => { socket.destroy(); done(false); });
    });
    if (!taken) return candidate;
  }
  return start;
}

function colleagueRun(socket, cert, extra) {
  const line = [
    'cargo run -q -p office-mumble-colleague --',
    `--server ${socket}`,
    `--cert ${cert}`,
    ...extra,
  ].join(' ');
  return capture(line);
}

/** A colleague that can be read while it runs and stopped when it is no longer needed. The browser peer is
 *  given a window to settle, and a run that samples once at a fixed second and then waits out the rest
 *  either reads the counters before they have grown or wastes the seconds after they have. */
function colleagueSession(socket, cert, extra) {
  const line = [
    'cargo run -q -p office-mumble-colleague --',
    `--server ${socket}`,
    `--cert ${cert}`,
    ...extra,
  ].join(' ');
  // Detached, so stopping it stops the shell, cargo and the colleague under them: killing the shell alone
  // leaves the binary holding a connection that the next run would then be counted against.
  const child = spawn(line, { cwd: root, shell: true, detached: true });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  let exited = false;
  const done = new Promise(resolve => child.on('exit', code => { exited = true; resolve({ code, out }); }));
  const stop = () => {
    if (exited) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  };
  return { done, read: () => out, stop, get exited() { return exited; } };
}

/** The browser on this machine, if there is one: the same check the design wants, without a Playwright dependency. */
function findBrowser() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
       '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
         '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  // The browser Playwright keeps, when one is installed — the one this was measured with.
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      const binary = join(cache, entry, 'chrome-linux', 'chrome');
      if (existsSync(binary)) return binary;
    }
  }
  return null;
}

/** The page's own counters, read over the DevTools protocol — `officeMumbleDummy.packets()`, awaited. */
async function dummyPackets(debugPort) {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const page = targets.find(target => target.type === 'page' && (target.url || '').includes('/dummy/'));
  if (!page) throw new Error('no harness page yet');
  return await new Promise((done, failed) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const giveUp = setTimeout(() => { socket.close(); failed(new Error('the page did not answer')); }, 8000);
    socket.onopen = () => socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: 'officeMumbleDummy.packets()', awaitPromise: true, returnByValue: true },
    }));
    socket.onerror = () => { clearTimeout(giveUp); failed(new Error('could not reach the browser')); };
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(giveUp);
      socket.close();
      const value = message.result?.result?.value;
      if (Array.isArray(value)) done(value);
      else failed(new Error(message.result?.exceptionDetails?.text ?? 'the page has no dummy yet'));
    };
  });
}

async function waitForDummy(debugPort, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await dummyPackets(debugPort); return true; } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

/** Reload the page. A headless first paint now and then stops before the page's module runs — the tab sits at
 *  "starting…" and no amount of waiting helps; loading it again wakes it, and then it behaves. */
async function reloadPage(debugPort) {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
  const page = targets.find(target => target.type === 'page' && (target.url || '').includes('/dummy/'));
  if (!page) return;
  await new Promise(done => {
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const finish = () => { try { socket.close(); } catch { /* already gone */ } done(); };
    socket.onopen = () => {
      socket.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
      setTimeout(finish, 600);
    };
    socket.onerror = finish;
  });
}

async function cmdVerify(flags) {
  const port = Number(flags.port ?? DEFAULT_VERIFY_PORT);
  const host = '127.0.0.1';
  const socket = socketUrl(host, port);
  const proofs = [];
  const check = (name, ok, detail) => {
    proofs.push({ name, ok });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `\n          ${detail}` : ''}`);
  };
  const note = text => console.log(`  ..    ${text}`);
  const step = text => console.log(`\n  ${text}`);

  console.log('\nchecking on this machine what this branch claims\n');
  try {
    if (!flags['no-build']) await ensureBuilt();
  } catch (error) {
    // Not fatal: everything below needs the server, and only the browser check needs the page it builds.
    note(`the client would not build (${error.message}) — carrying on; --no-build skips that step`);
  }

  step('the tests');
  const tests = await capture('cargo test --workspace');
  const passed = [...tests.out.matchAll(/test result: ok\. (\d+) passed/g)].reduce((sum, hit) => sum + Number(hit[1]), 0);
  check('cargo test --workspace', tests.code === 0 && passed > 0,
    tests.code === 0 ? `${passed} tests passed` : tail(tests.out));

  step(`a floor of its own on ${port}`);
  const env = {
    ...process.env,
    OFFICE_MUMBLE_PORT: String(port),
    OFFICE_MUMBLE_PLAN: String(flags.plan ?? 'fixtures/floor-t1.json'),
  };
  // Detached, so that stopping it stops cargo *and* the server under it: killing the shell alone left a floor
  // running and the next verify then found ids already taken.
  const startFloor = () => spawn('cargo run -p office-mumble-server', {
    cwd: root, env, shell: true, stdio: 'ignore', detached: true,
  });
  let server = startFloor();
  const stop = () => {
    const going = server;
    server = null;
    if (!going) return;
    try { process.kill(-going.pid, 'SIGTERM'); } catch { try { going.kill('SIGTERM'); } catch { /* already gone */ } }
  };
  process.on('SIGINT', () => { stop(); process.exit(130); });
  let listing = true;
  try { await waitForPort(port); } catch { listing = false; }
  check('the server comes up', listing, listing ? socket : `nothing listening on ${port}`);
  const cert = await certificateFor(socket);

  step('two colleagues within earshot');
  const [one, two] = await Promise.all([
    colleagueRun(socket, cert, ['--name', 'VerifyOne', '--seconds', '6']),
    colleagueRun(socket, cert, ['--name', 'VerifyTwo', '--seconds', '6']),
  ]);
  const a = lastLink(one.out);
  const b = lastLink(two.out);
  check('they find each other and connect', Boolean(a && b && a.up && b.up),
    a && b ? `#${a.id} and #${b.id}, level ${a.level} and ${b.level}` : `one: ${tail(one.out)} · two: ${tail(two.out)}`);
  const [sameA, sameB] = commonRows(one.out, two.out);
  const frames = Math.min(sameA?.decoded ?? 0, sameB?.decoded ?? 0);
  const clean = Boolean(sameA && sameB && sameA.frame === 960 && sameB.frame === 960
    && sameA.odd === 0 && sameA.bad === 0 && sameB.odd === 0 && sameB.bad === 0);
  check('every packet decodes to exactly one 20 ms frame, both ways', clean && frames > 0,
    sameA && sameB ? `${sameA.decoded} and ${sameB.decoded} frames at t=${sameA.at}s, odd 0, bad 0` : 'no frames');
  const agree = Boolean(sameA && sameB
    && near(sameA.gotBytes, sameB.sentBytes, 0.12) && near(sameB.gotBytes, sameA.sentBytes, 0.12));
  check('both sides count the same bytes', agree,
    sameA && sameB
      ? `at t=${sameA.at}s: one got ${sameA.gotBytes} B of two's ${sameB.sentBytes} B, two got ${sameB.gotBytes} B of one's ${sameA.sentBytes} B`
      : 'nothing to compare');

  step('one of them walks out of earshot');
  const planPath = String(flags.plan ?? 'fixtures/floor-t1.json');
  const floorPlan = planFloor(planPath);
  const away = floorPlan ? outOfEarshot(floorPlan.cells, floorPlan.cellM) : null;
  const [stay, leave] = await Promise.all([
    colleagueRun(socket, cert, ['--name', 'VerifyStay', '--seconds', '20']),
    colleagueRun(socket, cert, ['--name', 'VerifyLeave', '--seconds', '20', ...(away ? ['--at', away] : [])]),
  ]);
  const levels = levelsIn(stay.out);
  const heard = levels.some(level => level > 0.5);
  const quieter = levels.some(level => level === 0);
  const dropped = /closed the link to/.test(stay.out);
  check('the level fades to zero with distance', heard && quieter,
    levels.length ? `levels seen: ${Math.max(...levels)} down to ${Math.min(...levels)}` : 'no levels');
  check('the link is let go once it has been silent for the grace', dropped,
    dropped ? 'closed the link to …' : 'it was never closed');

  step('a door between two colleagues');
  const door = floorPlan ? findDoor(floorPlan.cells) : null;
  if (!floorPlan) {
    check('a shut door silences two colleagues, and opening it brings them back', false,
      `the plan at ${planPath} could not be read as a floor to find a door in`);
  } else if (!door.door) {
    check('a shut door silences two colleagues, and opening it brings them back', false,
      `no open door on this floor separates two walkable cells (${door.doors} doors separating, ${door.openDoors} of them open) — with none, the two sides cannot stand in earshot before the door is shut`);
  } else {
    const { row: doorRow, col: doorCol, a: sideA, b: sideB } = door.door;
    const centre = ([r, c]) => `${((c + 0.5) * floorPlan.cellM).toFixed(2)},${((r + 0.5) * floorPlan.cellM).toFixed(2)}`;
    // One colleague stands on each side and one of them works the door over the wire, exactly as a click
    // does: shut at 10 s, open again at 18 s. A shut door cuts at once, so the seconds in between are the
    // whole point — and the door was found and asked, above, not trusted because a number was once right.
    const [doorOne, doorTwo] = await Promise.all([
      colleagueRun(socket, cert, ['--name', 'VerifyDoorOne', '--seconds', '28', '--at', centre(sideA),
        '--door', `${doorRow},${doorCol}@10`, '--door', `${doorRow},${doorCol}@18`]),
      colleagueRun(socket, cert, ['--name', 'VerifyDoorTwo', '--seconds', '28', '--at', centre(sideB)]),
    ]);
    const rowsOne = linksIn(doorOne.out);
    const rowsTwo = linksIn(doorTwo.out);
    // A row that says voice is flowing to and from this colleague: the link is up, the level the rule gave
    // the peer is above zero, and whole frames have been decoded both ways.
    const spoke = (row, lo, hi) => Boolean(row && row.at >= lo && row.at <= hi && row.up && row.level > 0 && row.decoded > 0);
    const beforeOne = rowsOne.find(row => spoke(row, 2, 9)) ?? null;
    const beforeTwo = rowsTwo.find(row => spoke(row, 2, 9)) ?? null;
    const afterOne = rowsOne.find(row => spoke(row, 19, 28)) ?? null;
    const afterTwo = rowsTwo.find(row => spoke(row, 19, 28)) ?? null;
    // The shut door must leave no link at all: no line at a level above zero through the shut window, and a
    // report that says "no connections" outright. A zero level with the link still open would be somebody
    // walking away and waiting out the grace, which is a different thing from a door.
    const quietOne = rowsOne.every(row => !(row.at >= 11 && row.at <= 17 && row.level > 0));
    const quietTwo = rowsTwo.every(row => !(row.at >= 11 && row.at <= 17 && row.level > 0));
    const noConnections = out => [...out.matchAll(/^\s*(?:TOTAL|\s*t)\s+([\d.]+)s\s+no connections/gm)]
      .map(hit => Number(hit[1]));
    const goneOne = noConnections(doorOne.out).find(t => t >= 11 && t <= 17) ?? null;
    const goneTwo = noConnections(doorTwo.out).find(t => t >= 11 && t <= 17) ?? null;
    const closed = /closed the link to/.test(doorOne.out) && /closed the link to/.test(doorTwo.out);

    const before = Boolean(beforeOne && beforeTwo);
    const quiet = quietOne && quietTwo && goneOne !== null && goneTwo !== null && closed;
    const back = Boolean(afterOne && afterTwo);
    const shape = row => (row ? `level ${row.level}, decoded ${row.decoded} at t=${row.at}s` : 'never');
    check('a shut door silences two colleagues, and opening it brings them back', before && quiet && back,
      `door ${doorRow},${doorCol} between ${sideA} and ${sideB}: `
      + `open — one side ${shape(beforeOne)}, the other ${shape(beforeTwo)}; `
      + `shut over the wire at 10 s — ${quiet ? 'silent' : 'STILL HEARD'}, one link gone at t=${goneOne ?? '—'}s, the other at t=${goneTwo ?? '—'}s, both let go ${closed}; `
      + `open again at 18 s — one side ${shape(afterOne)}, the other ${shape(afterTwo)}`);
  }

  step('the floor blinks, mid-conversation');
  const [left, right] = [
    colleagueRun(socket, cert, ['--name', 'VerifyBlinkOne', '--seconds', '26']),
    colleagueRun(socket, cert, ['--name', 'VerifyBlinkTwo', '--seconds', '26']),
  ];
  await sleep(8000);
  stop();
  await sleep(2500);
  server = startFloor();
  let back = true;
  try { await waitForPort(port); } catch { back = false; }
  const [gone, returned] = await Promise.all([left, right]);
  // A link that is allowed to go, and a fresh one afterwards, with a *new* peer id: the thing the browser
  // client does and this must too, or one blink leaves a colleague deaf to somebody still standing next to it.
  const before = linksIn(gone.out).filter(row => row.at < 8 && row.up).map(row => row.id);
  const revived = [gone, returned].map(colleague => linksIn(colleague.out)
    .some(row => row.at > 14 && row.up && row.sent > 0 && row.decoded > 0 && !before.includes(row.id)));
  check('voice flows again through the new floor, on a new link', back && revived[0] && revived[1],
    back ? `peer before ${before.join('/') || 'none'}, after ${linksIn(returned.out).filter(row => row.up).map(row => row.id).join('/') || 'none'}`
      : 'the floor did not come back');

  step('a real browser peer');
  const chrome = findBrowser();
  if (!chrome) {
    note('no browser on this machine — set $CHROME to one and this check runs too');
  } else {
    const debugPort = await freePort(port + 1);
    const profile = mkdtempSync(join(tmpdir(), 'office-mumble-verify-'));
    // `server=` is not decoration: the page's own default is the ordinary floor on 8787, and this one is on a
    // port of its own, so a page left to its default would join somebody else's floor and see no colleague.
    const page = `https://${host}:${port}/dummy/?name=Dummy&source=file&server=${encodeURIComponent(socket)}`;
    const browser = spawn(chrome, [
      '--headless=new', '--no-sandbox', '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, page,
    ], { stdio: 'ignore', detached: true });
    let ready = await waitForDummy(debugPort, 12000);
    if (!ready) {
      // Seen now and then: the first paint of a headless page stops before its module runs. One reload wakes it.
      await reloadPage(debugPort);
      ready = await waitForDummy(debugPort, 25000);
    }
    if (!ready) {
      check('the harness page answers as a peer', false, 'the browser never exposed the page');
    } else {
      const running = colleagueSession(socket, cert, ['--name', 'VerifyBrowser', '--seconds', '60']);
      const opened = Date.now();
      // Wait for the counters to settle rather than sampling once: keep reading the page's own numbers as
      // they grow, and stop only when voice has flowed both ways and the two sides agree. A fixed moment
      // reads the counters before they are ready as often as after, which is what made this check red for no
      // reason. The window is bounded, and so is a failure: what the page had when it gave up is reported.
      const deadline = opened + 24000;
      let settled = null;
      let last = null;
      while (Date.now() < deadline) {
        await sleep(600);
        const seconds = (Date.now() - opened) / 1000;
        const seen = await dummyPackets(debugPort).catch(() => null);
        const peer = Array.isArray(seen) ? seen.find(entry => entry.connection === 'connected') ?? null : null;
        const row = lastTimed(running.read());
        last = { peer, row, seconds };
        const flowed = Boolean(peer && row && row.up && peer.receivedBytes > 0 && peer.sentBytes > 0 && row.decoded > 0);
        const agrees = flowed && near(row.sentBytes, peer.receivedBytes, 0.2) && near(row.gotBytes, peer.sentBytes, 0.2);
        // Twelve seconds in, a sample covers enough of the run that a second or two of clock skew between the
        // colleague's report and the page's counters is well inside the tolerance — so a healthy pair settles
        // while a genuine stall still fails. Before that the numbers are too small to compare honestly.
        if (agrees && seconds >= 12) {
          settled = { peer, row, seconds };
          break;
        }
      }
      running.stop();
      await running.done;
      const bothWays = Boolean(settled);
      check('the browser carries it in both directions, on its own counters', bothWays,
        settled
          ? `at t=${settled.row.at}s it received ${settled.peer.receivedBytes} B where the colleague sent ${settled.row.sentBytes} B; it sent ${settled.peer.sentBytes} B where the colleague got ${settled.row.gotBytes} B`
          : `the page never settled in 24 s: it had received ${last?.peer?.receivedBytes ?? 0} B and sent ${last?.peer?.sentBytes ?? 0} B of its own, while the colleague at t=${last?.row?.at ?? '—'}s had sent ${last?.row?.sentBytes ?? 0} B and got ${last?.row?.gotBytes ?? 0} B (up ${last?.row?.up ?? '—'}, decoded ${last?.row?.decoded ?? 0})`);
    }
    // Detached, so the whole browser goes and no half-dead one keeps the debugging port for the next run.
    // Chrome does not always take a polite signal, so this one is not polite.
    try { process.kill(-browser.pid, 'SIGKILL'); } catch { try { browser.kill('SIGKILL'); } catch { /* already gone */ } }
  }

  stop();
  const failed = proofs.filter(proof => !proof.ok);
  console.log('');
  if (failed.length === 0) console.log(`all ${proofs.length} checks passed`);
  else {
    console.log(`${failed.length} of ${proofs.length} checks failed:`);
    for (const proof of failed) console.log(`  - ${proof.name}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

// ── colleagues who walk about, so a person has somebody to look at ──────────
async function cmdWalkers(flags) {
  if (typeof WebSocket === 'undefined') {
    console.error('this Node has no built-in WebSocket — the walkers need Node 22 or newer');
    process.exit(1);
  }
  const server = String(flags.server ?? socketUrl(flags.local ? 'localhost' : lanAddress(), flags['server-port'] ?? DEFAULT_PORT));
  const cert = await certificateFor(server, flags.cert);

  if (process.env.NODE_EXTRA_CA_CERTS !== cert) {
    // Re-exec once with the server's certificate as a trust anchor. A walker that accepted any
    // certificate would be testing something other than what a person runs.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      cwd: root,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
    });
    child.on('exit', code => process.exit(code ?? 0));
    return;
  }

  const count = Number(flags.count ?? 3);
  const names = String(flags.names ?? '').split(',').map(n => n.trim()).filter(Boolean);
  const dwellMs = Number(flags.dwell ?? 4) * 1000;
  const once = flags.once === true;

  const walkers = [];
  for (let i = 0; i < count; i += 1) walkers.push(new Walker(names[i] ?? DEFAULT_NAMES[i % DEFAULT_NAMES.length], server, dwellMs, once, finish));
  for (const walker of walkers) walker.start();

  const done = [];
  function finish(name) {
    if (done.includes(name)) return;
    done.push(name);
    console.log(`  ${done.length}/${walkers.length} walkers done`);
    if (done.length === walkers.length) {
      console.log('all walkers are done');
      process.exit(0);
    }
  }

  process.on('SIGINT', () => {
    console.log('\nclosing the walkers');
    for (const walker of walkers) walker.close();
    setTimeout(() => process.exit(0), 300);
  });
}

/** The plan message as the server sends it, turned into the places one may stand: the same rule the server uses. */
function walkableCells(message) {
  const { cells } = message.plan.floors[0];
  const cellM = message.plan.cell_m;
  const reachable = [];
  cells.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell === 'floor' || cell === 'doorOpen') {
        reachable.push([(c + 0.5) * cellM, (r + 0.5) * cellM]);
      }
    });
  });
  return reachable;
}

class Walker {
  constructor(name, server, dwellMs, once, onDone) {
    this.name = name;
    this.server = server;
    this.dwellMs = dwellMs;
    this.once = once;
    this.onDone = onDone;
    this.cells = [];
    this.id = null;
    this.target = null;
    this.arrived = 0;
  }

  start() {
    this.socket = new WebSocket(this.server);
    this.socket.addEventListener('open', () => this.socket.send(JSON.stringify({ type: 'join', name: this.name })));
    this.socket.addEventListener('close', () => {
      console.log(`  ${this.name} was disconnected`);
      this.onDone(this.name);
    });
    this.socket.addEventListener('error', () => console.log(`  ${this.name} could not reach ${this.server}`));
    this.socket.addEventListener('message', event => this.receive(JSON.parse(event.data)));
  }

  receive(message) {
    if (message.type === 'plan') {
      this.cells = walkableCells(message);
      console.log(`  ${this.name} has the plan: ${this.cells.length} places to stand`);
    } else if (message.type === 'hello') {
      this.id = message.id;
      console.log(`  ${this.name} joined as ${message.id}`);
      this.decide();
    } else if (message.type === 'state') {
      const me = message.people.find(p => p.id === this.id);
      if (me && this.target) {
        const [tx, ty] = this.target;
        if (Math.hypot(me.x - tx, me.y - ty) < 0.15) this.decide();
      }
    } else if (message.type === 'no_way') {
      console.log(`  ${this.name} cannot get there — picking somewhere else`);
      this.decide();
    }
  }

  /** Somewhere to be, then hold still there for a moment: standing still is part of the picture. */
  decide() {
    if (this.arrived > 0 && this.once) return this.close();
    this.target = null;
    if (this.cells.length === 0 || this.socket.readyState !== 1) return;
    const [x, y] = this.cells[Math.floor(Math.random() * this.cells.length)];
    this.target = [x, y];
    this.arrived += 1;
    this.socket.send(JSON.stringify({ type: 'walk', x, y }));
    console.log(`  ${this.name} → ${x.toFixed(1)}, ${y.toFixed(1)}`);
    setTimeout(() => { if (this.target) this.decide(); }, this.dwellMs);
  }

  close() {
    try { this.socket.close(); } catch { /* already gone */ }
  }
}

/** The server's public half, from here if it was made here, otherwise fetched once the way a browser does. */
async function certificateFor(server, flag) {
  if (flag) return String(flag);
  const local = join(root, '.office-mumble', 'cert.pem');
  if (existsSync(local)) return local;
  const host = new URL(server).host;
  const where = join(root, 'harness', '.certs');
  const kept = join(where, `${host.replace(/[^a-z0-9.:-]/gi, '_')}.pem`);
  if (existsSync(kept)) return kept;
  mkdirSync(where, { recursive: true });
  console.log(`no certificate here yet — fetching ${host}'s public half once, unverified, the way a browser does when somebody clicks through the warning`);
  const pem = await new Promise((done, failed) => {
    httpsGet({ host: new URL(server).hostname, port: new URL(server).port, path: '/cert.pem', rejectUnauthorized: false }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => (body.includes('BEGIN CERTIFICATE') ? done(body) : failed(new Error(`no certificate at ${host}/cert.pem`))));
    }).on('error', failed);
  });
  writeFileSync(kept, pem, { mode: 0o644 });
  console.log(`  kept it at ${kept}`);
  return kept;
}

// ── dispatch ────────────────────────────────────────────────────────────────
function usage() {
  console.log(`The office, started from here.

  node harness/run.mjs server    run the floor on this machine and print where it is
                                 --port 8787  --plan fixtures/floor-t1.json  --names a,b
                                 --cert-dir .office-mumble  --name You  --open  --no-build
  node harness/run.mjs all       the same, and open the browser: everything in one command
  node harness/run.mjs test      the whole stand in one command: the floor, the browser, and Ada and Bob
                                 walking and talking, one recording each, until Ctrl-C. The hearing rule
                                 with something to hear.
                                 --names Ada,Bob  --voice a.wav,b.wav  --seconds 3600  --hops 120
                                 --port 8787  --plan fixtures/floor-t1.json  --no-open  --no-build
  node harness/run.mjs verify    check, with numbers, what this branch claims — for reviewing a pull
                                 request before it is merged. Runs the tests, puts two colleagues in
                                 earshot and one out of it, stands two on either side of a door and
                                 works it over the wire, and drives the harness page in a real
                                 browser if there is one. Exits non-zero if a check fails.
                                 --port 8899  --plan fixtures/floor-t1.json  --no-build
  node harness/run.mjs client    the client in development mode, with hot reload
                                 --server wss://host:8787/ws  --name You  --port 5173
                                 --local  --no-open
  node harness/run.mjs open      just open a server that is already running
                                 --host 192.168.0.10  --port 8787  --name You  --url <page>
  node harness/run.mjs dummy     a synthetic colleague, so a floor can be listened to alone
                                 --source file|tone|bursts|silence  --voice <recording.wav>
                                 --name Dummy  --no-open
  node harness/run.mjs walkers   colleagues who walk about, so there is somebody to look at
                                 --count 3  --names Ada,Bob,Cid  --dwell 4  --once
                                 --server wss://host:8787/ws  --local  --cert <file.pem>
  node harness/run.mjs colleague a colleague with no window: the hearing rule and voice, no browser
                                 --name Rusty  --seconds 30  --voice <recording.wav>
                                 --at x,y  --walk x,y@seconds  --door row,col@seconds
                                 --server wss://host:8787/ws  --local

  A certificate is a decision made once per machine: the server hands out its own public half at
  https://<host>:<port>/cert.pem. Install it and nothing asks again.

  The scenarios — server and clients on one machine, as commands to copy — are the comment at the top
  of this file, and the walkers are what puts somebody else in the office: all is the floor and you.`);
}

const { flags, rest } = parseArgs(process.argv.slice(2));
const command = rest[0] ?? 'help';

switch (command) {
  case 'server': await cmdServer(flags); break;
  case 'all': await cmdServer({ ...flags, open: true }); break;
  case 'test': await cmdTest(flags); break;
  case 'verify': await cmdVerify(flags); break;
  case 'client': await cmdClient(flags); break;
  case 'open': await cmdOpen(flags); break;
  case 'dummy': await cmdDummy(flags); break;
  case 'walkers': await cmdWalkers(flags); break;
  case 'colleague': await cmdColleague(flags); break;
  default: usage();
}
