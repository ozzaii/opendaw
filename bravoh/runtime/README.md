# BRAVOH's openDAW runtime

BRAVOH's Producer writes one JavaScript program per move. This folder makes that program an openDAW script.
`preamble.mjs` is loaded with `node --import` before the program, inside BRAVOH's sandbox (no network, a read-only
system). It defines `openDAW`, the scripting API of `@opendaw/studio-scripting`. Its `ScriptHostProtocol` host is
the program's own RPC hands: `external_studio_open`, `external_studio_apply`, `external_studio_mixdown` and
`external_studio_samples`. They are answered by the engine service that holds each song.

- `openInStudio()` resolves when the host has applied the edit as one undo step. It rejects when the song changed
  since the program read it (the checksum guard of `ScriptHostProtocol.applyUpdates`).
- `wire.mjs` carries the API's values (typed arrays, buffers, bigints) on a JSON wire.
- `proof.mjs` answers the four hands in-process and runs a build, an undo, a stale edit and an unapplied render.

```sh
npm install && npm run build && npm run proof
```

`npm run build` bundles the published packages in `package.json`. `npm run build:fork` bundles this fork's own
packages instead (after the workspace build), so a program gets the fork's scripting API: soundfonts, amp models,
WebCLAP plugins and `measure`. The host calls beyond the song travel on one more hand, `external_studio_host`
(`{call, args}`), which the song's openDAW page answers (BravohEngine.ts `host`). The image uses `build:fork`.

Licence: AGPL-3.0-or-later, like openDAW.
