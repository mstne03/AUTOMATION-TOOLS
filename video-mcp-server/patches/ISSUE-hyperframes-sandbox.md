<!--
Borrador. No publicar sin el sí de Marc (M3).
Antes de publicar: comprobar si heygen-com/hyperframes tiene SECURITY.md. Si lo tiene, la parte del
sandbox va por su aviso privado, no por una issue pública.
-->

# Windows: Chrome runs with `--no-sandbox`, and an invalid `HYPERFRAMES_BROWSER_PATH` falls back silently

## Problem

HyperFrames renders HTML that is often generated or supplied by someone other than the person running
the CLI, yet every Chrome launch on Windows disables the sandbox. `--no-sandbox` is hardcoded in
`buildChromeArgs`, `getHardwareGpuProbeArgs`, the audio effects browser and `buildHdrChromeArgs`.

On Windows the renderer therefore runs with the user's token instead of a restricted one. A bug in the
renderer gives an attacker the user's files and credentials, not just a sandboxed process.

## Measurements

Windows 11, dedicated GPU, Chrome for Testing `chrome-headless-shell` 152 and 156. Integrity level read
from the token of each renderer during a real `hyperframes render`:

| Configuration | Renderer integrity | Renders |
|---|---|---|
| Current (`--no-sandbox`) | Medium | OK |
| Full sandbox (no sandbox flags) | Untrusted | Hung in 5 of 6 runs |
| Renderer sandbox only (`--disable-gpu-sandbox`) | Untrusted | OK in 6 of 6 runs |

The cause of the hang with the GPU sandbox enabled is not identified.

## Proposal

1. Add a `--browser-sandbox=renderer|full|off` option, or default to `renderer` on Windows: drop
   `--no-sandbox` and `--disable-setuid-sandbox` and add `--disable-gpu-sandbox`.
2. Offer a hook to append Chrome arguments, so that integrators can close the browser's network access
   without patching `dist`. All launches already go through `withHyperframesBrowserMarker`.

This is what we apply locally in that function:

```diff
 function withHyperframesBrowserMarker(args = []) {
-  return args.includes(HYPERFRAMES_BROWSER_MARKER_ARG) ? [...args] : [...args, HYPERFRAMES_BROWSER_MARKER_ARG];
+  const a = process.platform === "win32" ? rendererSandboxArgs(args) : [...args];
+  return a.includes(HYPERFRAMES_BROWSER_MARKER_ARG) ? a : [...a, HYPERFRAMES_BROWSER_MARKER_ARG];
 }
```

```js
function rendererSandboxArgs(args) {
  if (args.some((a) => /^--(single-process|in-process-gpu)(=|$)/.test(a))) {
    throw new Error("--single-process would take the renderer out of the sandbox");
  }
  const extra = args.includes("--no-sandbox") ? ["--disable-gpu-sandbox"] : [];
  return [...args.filter((a) => !/^--(no-sandbox|disable-setuid-sandbox)$/.test(a)), ...extra];
}
```

## Second request: `HYPERFRAMES_BROWSER_PATH` should fail closed

When `HYPERFRAMES_BROWSER_PATH` is set but does not point to a file, `findFromEnv` returns `undefined` and
the CLI moves on to its cache, the system Chrome or a download. Someone who pins a browser expects that
exact browser or an error, not a different binary. A directory also passes, because the check is
`existsSync`.

Suggested behaviour: if the variable is defined and is not a regular file, throw and do not fall back.

## Related

The preflight that runs `chrome --version` (reported separately).
