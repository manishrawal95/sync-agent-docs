# Security

sync-agent-docs reads files that often hold secrets, so its safety promises matter more than its features.

## Reporting a problem

Use GitHub's private reporting: the repo's **Security** tab, then **Report a vulnerability**. Please do not open a public issue. You will get a reply within a week.

Include the version (`sync-agent-docs --version`), your OS and a made-up folder that reproduces it. Never send a real secret or a real report from your machine.

## What counts

Any of these is a security bug, and its fix goes out ahead of other work:

- A secret value, or more than its first four characters, reaches a report, the terminal, a log, an error message or the truth store.
- `scan` writes anything outside `<root>/.sync-agent-docs/`.
- Any command opens a network connection without `doctor --live`, or sends anything to an AI tool without `plan --ai` and the user's yes.
- A child process other than `git` and `crontab -l` runs, or a scanned repo's git config or filters run something.
- A command writes to a repo with uncommitted changes, overwrites a hand edit, merges, force-updates or pushes.
- Text from a scanned file is run, or reaches the terminal with control characters intact.

## Supported versions

Only the latest release gets fixes.
