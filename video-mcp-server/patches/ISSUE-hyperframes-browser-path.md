# `HYPERFRAMES_BROWSER_PATH` falls back silently when it is invalid

## Problem

When `HYPERFRAMES_BROWSER_PATH` is set but does not point to a file, `findFromEnv` returns `undefined` and
the CLI moves on to its cache, the system Chrome or a download. Someone who pins a browser expects that
exact browser or an error, not a different binary. A directory also passes, because the check is
`existsSync`.

## Proposal

If the variable is defined and is not a regular file, throw and do not fall back. `browserPathFromEnv` is
the common point: every lookup of `HYPERFRAMES_BROWSER_PATH` and `PRODUCER_HEADLESS_SHELL_PATH` goes
through it.
