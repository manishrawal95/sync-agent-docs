# Contributing

Bug reports, false findings and new config formats are all welcome.

## Before you open an issue

A scan report describes your machine: host names, ports, repo names and file paths. Before you paste one, replace anything you would not post publicly. A secret is reported only by file and line with its first four characters, but check anyway.

The most useful report of a wrong finding is a small made-up folder that reproduces it.

## Setup

Node 24 and git.

```sh
git clone https://github.com/manishrawal95/sync-agent-docs.git
cd sync-agent-docs
npm ci
npm run dev -- scan tests/fixtures/messy-dev
```

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on the behaviour before you write it.
2. Read [AGENTS.md](AGENTS.md). It lists the promises the code keeps and the fixture rules.
3. Add a failing test, then the change.
4. Run the four checks: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. CI runs the same four.
5. Add a `CHANGELOG.md` line if users would notice the change.
6. Keep each pull request to one change.

## Adding a config format

Each format a scan reads as ground truth lives in `src/truth/formats/`. A new one needs a parser there, an entry in `src/truth/parse.ts`, a synthetic fixture, and tests for both what it reads and what it leaves out.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
