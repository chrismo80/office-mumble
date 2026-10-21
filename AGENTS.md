# office-mumble — working agreement

Map of this repo, the conventions we work by, and the ritual for a session.
Read this first.

## What this is

Self-hosted voice presence for one small team: colleagues who work from home should be
able to talk the way they would in a corridor or by the coffee machine.

`office-mumble` · *Nobody schedules a mumble.*

## Documents — one topic each

A file earns its place by telling you something that is true **right now** and is not
already in another file. That is the test for a new file as much as for an old one: a fact
that fits an existing document goes there, and a topic of its own — something new that has
a reader of its own — gets a document of its own and a row in this table. What is kept out
is sprawl: notes, logs and second copies, not documents.

| File | Holds | Changes |
|---|---|---|
| `README.md` | what it is, what it looks like, how to start it | rarely |
| `docs/architecture.md` | how it is built and why: workspace, wire, the rule twice, the voice path | as the build moves |
| `docs/setup.md` | installing it for a team: certificate, machines, the app, Opus | when the install changes |
| `docs/scripts.md` | the build and run scripts: steps, recipes, entry points, which office the app is for | when a script changes |
| `docs/tls.md` | the certificate, the key, the handshake, the formats | when the certificate or the connection changes |
| `docs/art.md` | figures, furniture and floors, and how to change them | when the art changes |
| `AGENTS.md` | this file: map, conventions, ritual | when the way we work changes |

## Conventions

- **Markdown states the current state only.** Not a diary, not a log, not memory.
  A document that stops being true is corrected or deleted. History lives in git.
- **The commit message carries the _why_** — including what was rejected and why.
  This is the one discipline everything else depends on: the documents hold the state,
  git holds the reasoning.
- **One topic, one document.** Never the same fact in two files.
- **Questions before documents.** When a session changes what the project *is*, it starts
  with questions to the owner, not with rewritten files. A document written from a guess is
  worse than none, because it reads as agreed.
- **A document describes the thing, never the people building it.** Nobody's skill, taste or
  habits belong in an artifact the project is built from: such a sentence goes stale, and later
  it is read as a finding instead of as an aside. A reason has to hold without naming anybody,
  or it is not a reason.
- **Lowercase filenames under `docs/`.** Linux is case-sensitive, Windows and macOS are
  not — `Vision.md` next to `vision.md` causes phantom renames on one platform only.
- **One increment, one branch, merged into `main` without a pull request.** The branch keeps an
  increment together and off `main` until it works; then it is merged into `main` directly, a fast
  forward where the history allows one. With no pull request to read a change in, the commit message is
  where it is read — one more reason it carries the why. Pushing is the owner's call.
- **A merge into `main` carries a function or a real milestone.** Not an investigation, and not the notes
  of one: a finding belongs where it is needed — in the increment that asked the question, or in a
  document — rather than in a merge of its own. The test is whether `main` is better in a way somebody
  can use once it is merged.
- **Branch prefixes keep the history legible.** `chore/` for the working agreement and tooling, `docs/`
  for documents, `feat/` for the thing itself, `spike/` for a throwaway probe. A spike exists to answer
  a question and may be abandoned rather than merged: what survives it is the finding, written into a
  document, not the code.

## Session ritual

1. Read this file, then `docs/architecture.md` (how it is built), then the recent commits.
2. **Run the tests before touching anything** — verify nothing is already broken. The commands are in
   the README, under *Tests*.
3. One increment, on its own branch. Not five.
4. Before finishing: update `docs/architecture.md` if the shape changed, commit with the reason, merge the branch into `main`,
   and leave the next step written down.

## Note on the name

`office-mumble` is free on crates.io, npm and PyPI, and all four obvious domains are
unregistered. We are not publishing, so the crate name stays local. If that ever
changes, claim the crates.io name first.

`mumble` alone is an existing self-hosted voice-chat project (`mumble-voip/mumble`).
Unrelated to this one.
