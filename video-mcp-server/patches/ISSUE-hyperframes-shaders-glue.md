BORRADOR — no publicar sin el sí de Marc (M3)

# `shaders` bundle: one render per `hf-seek` builds an unbounded queue and freezes after a rejection

## Problem

The `shaders` runtime bundle (`compositions/lib/shaders.iife.js`, shaders 4.0.0) serialises every
`renderSyntheticFrame` call in a promise chain. Each `hf-seek` event appends one render to the chain and
each render waits for the GPU (`queue.onSubmittedWorkDone()`), so the chain never coalesces.

The `typegpu` adapter of the HyperFrames runtime dispatches an `hf-seek` on every animation frame while the
player is playing. With a shader background (`aurora`) this produced ~144 `hf-seek` events per second
against ~101 renders per second sustained by the GPU. Observed in a 50 s play:

- the queue held ~2200 pending renders when the player paused;
- the canvas lagged the clock by up to 16 s during the play and kept moving for ~17 s after pausing;
- a seek issued right after pausing is queued behind those ~2200 renders, so a screenshot taken inside that
  window shows a different phase of the animation than the one requested.

Whether this is visible depends on the GPU and the display refresh rate: inside a sandboxed iframe the GPU
sustained 133–142 renders per second and the backlog was 97–506, which drained before most captures.

A second, latent problem is in the same line: when one render rejects, the chain stays rejected forever and
every later `hf-seek` is skipped, so the background freezes.

## Reproduction

1. Chrome 156 (`--headless=new`) with WebGPU on a hardware adapter, a 1080×1920 composition with one
   `<canvas data-shader="aurora">` and `data-no-timeline`, 50.4 s long.
2. Open it in the player and call `play()` for 50 s, then `pause()`.
3. Read the number of pending `renderSyntheticFrame` promises (wrap the glue to count enqueued and settled
   calls): it is in the thousands.
4. Call `seek(10)` and take a screenshot immediately. The canvas shows the animation at ~34–50 s, not at 10 s,
   until the queue drains (~17 s later).

Rejection case: make one `renderSyntheticFrame` reject (for instance by losing the device); after that,
`hf-seek` no longer changes the canvas.

## Proposal

Keep only the last requested time and let a single loop render it. The promise returned to the caller
resolves when a time equal to or later than the one it asked for has been painted, so the frame-by-frame
render path (seek, wait, capture) behaves as before: there is never more than one pending request there.

This is the last line of `shaders.iife.js`; only the first statement of the glue changes:

```diff
-Ji=YE(),T0=Promise.resolve();function OE(e){return T0=T0.then(()=>Ji.renderSyntheticFrame(e-Ji.__testing.getFrameDiagnostics().globalElapsedTime)),T0}
+Ji=YE(),T0=null,hfPendiente=0,hfHay=!1;function OE(e){if(!Number.isFinite(e))return T0||Promise.resolve();hfPendiente=e;hfHay=!0;return T0||(T0=(async()=>{await null;try{for(;hfHay;){hfHay=!1;let t=hfPendiente;await Ji.renderSyntheticFrame(t-Ji.__testing.getFrameDiagnostics().globalElapsedTime)}}finally{T0=null;hfHay&&OE(hfPendiente).catch(()=>{})}})())}
```

(`hfPendiente` and `hfHay` are new names; the source should use proper identifiers.)

Details that matter:

- `await null` is the first statement of the async body, so `T0` is assigned before the body runs. Without it,
  a synchronous `throw` (for example from `getFrameDiagnostics()`) would leave `T0` pointing at an already
  settled promise.
- `null`, `NaN` and `Infinity` are ignored; `hfHay` is a separate flag, so `null` is not a sentinel.
- If a render rejects while new requests arrived, `finally` restarts the loop with the latest one. The caller
  that was waiting receives the rejection.

## Measurements

Unit tests with a fake `Ji` (sixty calls in a row, `null`/`NaN`/`Infinity`, a synchronous throw, a rejection,
a rejection with newer requests pending): one render in flight at most, at most three renders for sixty
calls, the last value is painted, and the chain never stays frozen. The unpatched glue renders sixty times
for the same sixty calls.

In a real browser (Chrome 156, hardware WebGPU adapter), with the patch: after a 50 s play, after three plays in a
row, after a pause halfway and after sixty seeks in one second, screenshots at 1, 10, 25 and 45 s were
byte-identical to the reference taken without playing first (3 repetitions each, 12 of 12), inside a sandboxed
iframe and in the same document. The wait until the canvas was ready was 32–67 ms.
