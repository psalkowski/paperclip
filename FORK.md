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
| Let stranded SSH leases on one host be recovered and released | paperclipai/paperclip#15698 (issue paperclipai/paperclip#15676) | an upstream release contains paperclipai/paperclip#15698 or another fix for paperclipai/paperclip#15676 |
| A company pause lets running runs finish and keeps company-paused agents assignable | issue paperclipai/paperclip#18344 | an upstream release makes a company pause graceful |
| Estimate the API list-price equivalent of Codex subscription runs | — | upstream prices subscription runs |
