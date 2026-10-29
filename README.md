# sync-agent-docs

Your infra facts live in a dozen agent instruction files and READMEs, and the copies drift. `sync-agent-docs scan` finds the conflicts, stale references, duplicated context and plain-text secrets across your repos and your coding-agent config, locally, with no AI and no network.

```sh
npx sync-agent-docs scan ~/dev
```

Node 24. The scan writes only inside `<path>/.sync-agent-docs/`, which holds its own `.gitignore`, so nothing it writes gets committed.

## What it reads, what it never reads

| Where | Reads | Never reads |
|---|---|---|
| Repos: every folder with a `.git` under the path you give | Markdown files (agent files, READMEs, docs; not `CHANGELOG.md` or `HISTORY.md`), `.md` and `.mdc` files anywhere under `.cursor/rules/`, `package.json`, `wrangler.*`, `vercel.json`, `.vercel/project.json`, pm2 `ecosystem.config.*`, `compose*.yml`, `fly.toml`, `Procfile`, `.env*`, `.github/workflows/*.yml` (secret names only, `secrets.NAME`, never values), git remote URLs | Files git ignores by any rule (nested `.gitignore`, `.git/info/exclude`, your global excludes; a folder without git uses its root `.gitignore`), except `.env*` and `.vercel/`; `node_modules`, `.venv`, `venv`, `dist`, `build`, `.next`, `.worktrees`, test fixture folders, binary files, files over 512 KB |
| `.env*` files | Variable names: each line is cut at `=` as it is read | Values. They are dropped before the line is kept, so no secret value reaches the report, a log or an error |
| Your home folder (`--repos-only` skips all of it) | `~/.claude/CLAUDE.md` and Claude memory files, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `.md` and `.mdc` files anywhere under `~/.cursor/rules/`, `~/.ssh/config`, `~/.gitconfig` (paths only), `~/.config/gh/hosts.yml` (host names only), `~/.zshrc`, `~/.bashrc` and `~/.profile` (variable names only), LaunchAgents and systemd user units (paths and names only), `crontab -l` | SSH keys, the token lines in `gh/hosts.yml`, the values in shell rc files, and every other file in your home folder |
| Programs it runs | `git` (remote URLs, branches, commits), `crontab -l` | Anything else. `plan --ai` runs your `claude` command only after you say yes, with its tools off |
| Network | Nothing | Every connection, except `doctor --live`: one `HEAD /` to hosts the store already records, public addresses only unless you mark a host as local |

The report's first screen lists every file it read from your home folder. A plain-text secret in a doc or agent file is reported by file and line, with at most its first four characters.

## Plan, apply, rollback

```sh
sync-agent-docs scan ~/dev        # find conflicts, stale lines, duplicates and secrets
sync-agent-docs plan ~/dev        # turn them into questions and answer them
sync-agent-docs apply ~/dev       # write the answers on new branches
sync-agent-docs compile ~/dev     # write the store's facts into each repo's agent files
sync-agent-docs rollback ~/dev    # delete the branches the last apply or compile made
sync-agent-docs doctor ~/dev      # check that files and branches still match the store
```

`plan` sorts what the scan found into five tiers: changes it can make without asking, conflicts, duplicates, stale lines and secrets. It asks about each open one and remembers your answer in the truth store, so it does not ask again. Pass `--json` to get the plan without questions, or `--accept-auto` to approve the first tier in one go. Answers can also be edited by hand in `.sync-agent-docs/plan.json`.

`apply` writes the answered plan. Each repo it changes gets a new `sync-agent-docs/apply-<time>` branch with one commit, and the original branch is left as it was. It stops before writing anything if a repo has uncommitted changes to tracked files (an untracked file of yours is left alone), is on a detached HEAD, or a line it would change has changed since the plan. If a step fails partway, such as a commit hook saying no, apply undoes what it wrote and deletes its branches. If apply is cut off before it can do that, `sync-agent-docs rollback` finishes the job and keeps any half-written edits in a git stash. It never merges and never pushes: you review each branch and merge it yourself.

The truth store is a git repo inside your home folder, `~/dev/truth` unless you pass `plan --store`. `apply` writes to the store the plan names. The store holds the facts as JSON, plus generated views (`hosts.md`, `services.md` and one `projects/<name>.md` card per repo). Facts sit inside marked blocks, and anything you write outside those blocks is kept. If you edit a block by hand, the next `plan` asks whether to keep your edit or replace it.

`plan --ai` is optional. Some doc lines name a port or an address without saying which project it belongs to. With `--ai`, sync-agent-docs finds your `claude` command, shows how many lines it would send and roughly how many tokens that is, and sends nothing unless you say yes. Only those lines and the names of your projects, hosts and services go, never a line flagged as a secret. Each suggestion comes back as a yes or no question; nothing is decided for you. The agent runs with its tools off, in an empty folder, so it can only read the lines and reply. The lines go to `claude` on its standard input, never on its command line, so other users of the machine cannot read them in `ps`. `codex` and `gemini` are not supported yet, because sync-agent-docs cannot confirm a tools-off mode for them.

`rollback` deletes the branches of the last apply or compile and puts each repo back on the branch it was on. It refuses if one of those branches has commits that apply did not make. A branch you already merged is kept, and rollback tells you to revert the merge by hand.

`plan`, `apply`, `compile` and `rollback` take a lock, `.sync-agent-docs/run.lock`, holding the process id, start time and command. A second one started on the same folder while the first runs is refused, naming that process and when it started, and writes nothing. `apply`, `compile` and `rollback` also lock the truth store, at `<store>/.git/sync-agent-docs-run.lock` (inside `.git`, so the store's files never change), because runs from different folders can share one store; `plan` only reads the store and does not take it. A lock left by a run that was killed is taken over once its process is gone.

## Compile

`compile` writes the facts each repo depends on into that repo's agent files: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md` and `.cursor/rules/sync-agent-docs.mdc`. A repo depends on its own project, on every entity with a fact sourced in the repo, and on entities a plan answer said are the same thing. The facts go in one marked block per file, and everything outside the block is kept:

```md
<!-- sync-agent-docs:begin compiled -->
<!-- sync-agent-docs:hash <first 16 hex digits of the body's sha256> -->
## Facts from the truth store
...
<!-- sync-agent-docs:end compiled -->
```

The hash line records the block's own body, so sync-agent-docs can tell when someone edited it by hand. `CLAUDE.md` also gets an `@` import of the repo's project card. If you already put that import line outside the block yourself, the block leaves out the project's own facts, since the card lists them; when CLAUDE.md is the same file as another agent file (a link), the block keeps them, because Codex and Gemini do not follow `@` imports. The `.mdc` file gets Cursor frontmatter with `alwaysApply: true`. A file that is not there is only created when the repo lists that format under `formats` in the store's `sync-agent-docs.json`, for example `{ "name": "shop", "path": "shop", "formats": ["gemini"] }`; a Cursor rule is also written when the repo already has `.cursor/rules`. A secret never reaches a block: the store keeps only where a secret was found, never its value.

`apply` compiles in the same commit as its other edits to each repo. `compile` on its own puts each changed repo on a new `sync-agent-docs/compile-<time>` branch with one commit, with the same checks as apply: it stops before writing if a repo has uncommitted changes, undoes everything if a step fails, and `rollback` deletes its branches. When nothing changed, it says so and makes no branch. It never merges or pushes. It leaves alone a file git ignores or does not track, and a file that is a link to somewhere outside the repo, and says so.

If you edit inside a compiled block by hand, `compile` refuses and names the file; it never overwrites the edit. Run `sync-agent-docs plan`: it asks whether to discard the edit (the block is rewritten from the store) or keep it, and `apply` or the next `compile` follows your answer. To change a fact for good, change it in the store.

`scan` does not read a compiled block as claims, so the same block in several agent files is never reported as duplicated context. It still looks there for secrets.

### For tools that check drift

`src/compile/block.ts` is the one reader and writer of the block (`readCompiledBlock`, `writeCompiledBlock`, `bodyHash`). `src/compile/compile.ts` exports the drift check, which reads files only and runs git only through the checker you pass:

```ts
compiledDrift(repoPath: string, store: Store, ctx: CompileContext): Promise<CompiledDrift[]>
// CompileContext = { storeDir: string; home: string; isIgnoredOrUntracked?: (file: string) => Promise<boolean> }
// CompiledDrift = { file: string; kind: 'edited' | 'missing' | 'stale' } | { file: string; kind: 'skipped'; reason: string }
isIgnoredOrUntracked(file: string): Promise<boolean> // the git-backed checker
```

`file` is absolute. `edited` means the body no longer matches its hash (a block with broken markers counts as edited), `missing` means a file that should hold a block has none, and `stale` means the block is intact but behind the store. `skipped` means compile leaves the file alone: either it is an agent-file link that dangles, leads outside the repo or points at a file that is not one of the five agent files (always reported, no git), or it would drift but git ignores it or does not track it (reported only when you pass `isIgnoredOrUntracked`; without it no git runs). `sync-agent-docs doctor` calls this and reimplements none of it.

Values and entity names in a compiled block are code spans, with any backtick shown as `'`, so text in them is never read as an instruction such as a Claude `@` import.

### Files outside git

Some agent files live outside any repo, such as `~/.claude/CLAUDE.md`. sync-agent-docs never changes those. When the plan would edit one, `apply` writes a patch to `.sync-agent-docs/manual/` instead, with the command to apply it. The same goes for a file inside a repo that git does not track, such as an ignored one. You read the patch and decide.

A secret is never copied into a commit, a patch, the plan or the store. `apply` removes the line from files in git; for a file outside git, the patch only says which line to remove, and rotating the secret is up to you.

## Doctor

`doctor` reruns every check against the store and reports drift. It changes nothing: the only file it writes is `.sync-agent-docs/doctor.json`, the result of its last run (and `.sync-agent-docs/.gitignore` when it is missing or changed). It exits 0 when there is no drift, 1 when there is, and 2 when doctor itself could not run (no store, a bad `checks.json`, a repo git cannot read), with the file and the next step in the message. When a run fails this way, doctor first deletes the `doctor.json` an earlier run left, so a cron job never reads an old clean result as current: a missing `doctor.json` means the last run failed or never ran. A usage error such as an unknown option, and a `.sync-agent-docs` folder doctor refuses (a link, or tracked by git), change nothing.

| Check | Drift when |
|---|---|
| `rescan` | a fresh scan raises a plan item the last plan did not show. Items the last plan showed and you left open are one note with their count. |
| `fact-checks` | a config file the store cites for a fact no longer says that value. |
| `compiled` | a compiled block was edited by hand, is missing, or is behind the store. A file compile leaves alone, and an edit you chose to keep, are notes. |
| `loaded-size` | an agent file a listed repo holds, plus for `CLAUDE.md` each line that is only an `@` import of a file inside the scanned folder or the store (one level, sizes only), is over 8 KB. A file linked to another counts once. The key names the 8 KB band it is in, so accepting one size does not accept a bigger one. |
| `views` | a view block was edited by hand, or a view file is missing or out of date with the store. |
| `branches` | a `sync-agent-docs/apply-*` or `sync-agent-docs/compile-*` branch, in a listed repo or the store, is not merged into any branch of yours. |
| `applies` | an apply in `.sync-agent-docs/applies.json` that was not rolled back stopped before committing in a repo, lost its branch before it was merged, or has a branch with commits apply did not make that is not merged. |
| `secrets` | a secret you chose to rotate by hand is still on its recorded line. Only the path and line are shown. |
| `live` | with `--live` only: a recorded target times out, refuses the connection or answers 5xx. |

Options: `--store <path>` (the store, as for `compile`), `--repos-only` (passed to the rescan; machine-file facts are counted in one note, not checked), `--json` (print the result below instead of the report) and `--live`.

### checks.json

`.sync-agent-docs/checks.json` is yours to edit; doctor only reads it. Turn a check off by its id, or accept one finding by the `key` the report prints under it. An accepted finding is still listed but no longer fails the run, and an accepted key that matched nothing in a check that ran is listed as a note so you can remove it. An unknown id, a key that does not start with a check id or any other field is an error naming the entry.

```json
{ "schema": 1, "disabled": ["live"], "accepted": ["compiled:shop/CLAUDE.md:edited"] }
```

### --live

Without `--live`, doctor opens no network connection. With it, doctor checks only what the store records: each `url` fact (http and https only) and each `domain` fact (as `https://<domain>/`) with one `HEAD /` request to that URL's origin, and each `ip` of an entity with each of that entity's `port` facts with one TCP connect. A request sends only a `user-agent: sync-agent-docs-doctor` header, never credentials, cookies or a body; a URL is shown as scheme, host, port and path, without credentials, query or fragment, but only `/` is requested, never the recorded path, because a `HEAD` to a route such as `/api/cron/...` can run that route's GET handler. A redirect is reported, not followed. Each name is resolved once and the connection goes to the address that was checked. Each target gets 3 seconds, and at most 4 run at once.

Before it contacts anything, doctor prints the full list to stderr. Doctor contacts a target only when every address it resolves to is global unicast, and it connects to the address it checked, with no second lookup. A target with any private, loopback, link-local, CGNAT (Tailscale), reserved, documentation, multicast, NAT64 or 6to4 address, or an IPv4-mapped address carrying one of those, is skipped unless you mark its entity in the store's `store/entities.json`:

```json
{ "id": "host:lab", "kind": "host", "names": ["lab"], "identifiers": {}, "notes": "", "network": "local" }
```

`network` is `local` or `tailnet`; either lets doctor contact that entity's private addresses. Any other value is an error.

### --json

`--json` prints the result as one JSON document on stdout (the `--live` list goes to stderr). `.sync-agent-docs/doctor.json` holds the same document. The shape is stable for `schema: 1`:

```ts
{
  schema: 1;
  at: string;              // ISO time of the run
  root: string;            // the scanned folder
  store: string;           // the truth store folder
  drift: boolean;          // true when any check has status 'drift'; the exit code is 1
  checks: {
    id: 'rescan' | 'fact-checks' | 'compiled' | 'loaded-size' | 'views' | 'branches' | 'applies' | 'secrets' | 'live';
    status: 'clean' | 'drift' | 'disabled';
    findings: {
      key: string;         // stable id; put it in checks.json accepted to accept the finding
      level: 'drift' | 'accepted' | 'note';
      message: string;     // what drifted and what to run next; never a secret value
      path?: string;       // the file or repo, short form
    }[];
  }[];
  live: {                  // null without --live
    kind: 'http' | 'tcp';
    target: string;        // scheme://host[:port]/path, or ip:port
    entityId: string;
    result?: 'ok' | 'failed' | 'skipped';
    detail?: string;       // status code, error or why it was skipped
  }[] | null;
}
```

The `live` check runs only with `--live`, so without it `checks` has seven entries.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and checks, [AGENTS.md](AGENTS.md) the promises every change keeps, and [SECURITY.md](SECURITY.md) how to report a security problem privately.

## License

MIT
