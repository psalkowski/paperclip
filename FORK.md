# Fork

This is a fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip). It carries a small set of
patches on top of upstream releases and publishes its own container image.

## Branches, tags and images

- `master` mirrors upstream and is never changed here.
- `fork/main` is the current release: an upstream release tag merged in, plus the patches below. It only moves
  forward (merges and fast-forwards, no rewrites).
- `fork/candidate/v<version>-<n>` is a release candidate. Every push builds
  `ghcr.io/psalkowski/paperclip:sha-<commit>`.
- `fork/v<version>-<n>` tags a tested candidate. The tag adds `ghcr.io/psalkowski/paperclip:<version>-fork.<n>`
  to the image already built for that commit; it does not rebuild. Tags are never moved or reused.

Upstream's workflows are removed; `.github/workflows/fork-image.yml` is the only workflow.

## Patches

| Patch | Upstream | Retired when |
| ----- | -------- | ------------ |
| Accept a released SSH lease without a termination receipt as stopped | paperclipai/paperclip#17234 (issue paperclipai/paperclip#16346) | an upstream release contains paperclipai/paperclip#17234 or another fix for paperclipai/paperclip#16346 |
| Recognize reused process groups and never-dispatched legacy runs as stopped | paperclipai/paperclip#17226 | an upstream release contains paperclipai/paperclip#17226 or another fix for paperclipai/paperclip#18147 / paperclipai/paperclip#17718 |
| Read only stop-proof columns when an agent stops, so pausing many agents with long run histories does not exhaust memory | paperclipai/paperclip#17236 (issue paperclipai/paperclip#17705) | an upstream release contains paperclipai/paperclip#17236 or another fix for paperclipai/paperclip#17705 |
| Let stranded SSH leases on one host be recovered and released | paperclipai/paperclip#15698 (issue paperclipai/paperclip#15676) | an upstream release contains paperclipai/paperclip#15698 or another fix for paperclipai/paperclip#15676 |
| A company pause lets running runs finish, keeps company-paused agents assignable, does not escalate their assigned work as stranded, and returns an agent still waiting on its runs to work when the company resumes | issue paperclipai/paperclip#18344 | an upstream release makes a company pause graceful |
| Estimate the API list-price equivalent of Codex subscription runs | — | upstream prices subscription runs |
| A run that hands its own issue to another agent does not open a reconciliation hold when the issue comes back to its agent | issue paperclipai/paperclip#16057 | an upstream release exempts a self-requested hand-off cancel from the reconciliation hold |
| Read an agent's subscription quota windows on its SSH environment (`GET /api/agents/:id/quota-windows`), and label Codex windows by their duration | — | upstream reads quota where agents run, and labels Codex windows by duration |
| Re-admit a stage hand-off (review, approval or changes-requested return) that was skipped while the finishing run still held its environment lease | paperclipai/paperclip#13880 (issue paperclipai/paperclip#13532) | an upstream release contains paperclipai/paperclip#13880 or another fix for paperclipai/paperclip#13532 |
| Copy an SSH environment's git history back only once the whole bundle is on disk, verify its size against the remote's and transfer it again when it is short; when a `claude_local` or `codex_local` SSH copy-back still fails, the run keeps the provider's outcome (a finished run stays `succeeded`) with `resultJson.workspaceRestoreWarning: "ssh_copy_back_failed"` and a log line naming the remote workspace that keeps its work | — | an upstream release waits for the local bundle file to finish before importing it and keeps a finished SSH run when only its copy-back fails |
| Deliver an agent's configured secrets to Codex CLI shell commands, so the environment's `GH_TOKEN` and Git credential helper (`GIT_CONFIG_KEY_n`) and an agent's own keys reach them; the ACP engine is not ported | paperclipai/paperclip#17216 | an upstream release contains paperclipai/paperclip#17216 or another fix that admits configured secret names to the Codex shell |
