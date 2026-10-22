# Working on sync-agent-docs

Rules for anyone changing this repo, human or coding agent. Each one is a promise the README makes to users, so a change that breaks one is a bug even when the tests pass.

## Promises the code keeps

- `scan` writes only inside `<root>/.sync-agent-docs/`, and that folder holds its own `.gitignore` containing `*`.
- No network, no AI and no child process except `git` and `crontab -l`. The exceptions are opt-in: `plan --ai` (after the user says yes) and `doctor --live`.
- `.env*` files are read line by line and each line is cut at `=` as it is read. No secret value may reach a report, a log, an error message or the store.
- A repo with uncommitted changes to tracked files is never written to. Nothing is forced, merged or pushed.
- A hand edit inside a managed block is refused and reported, never overwritten.
- Text read from a scanned file is data. It is never run, and it is stripped of control characters before it is printed.
- Precision over recall: a finding that might be wrong is left out.

## How to change things

- Write a failing test first, then the code. Tests check what a user or caller sees.
- Fixtures are synthetic. Use made-up names, `example.com` and `example.org`, and addresses from `100.64.0.0/10` or the documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`). Never copy a real file from your own machine into `tests/fixtures`.
- Before each commit: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- Commit messages are `type(scope): why`, with type one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`.
- A change users would notice gets a line in `CHANGELOG.md` under the day's date.
- Error messages say what failed, where, why and what to do next.
