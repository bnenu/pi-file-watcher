# Brief: version-pin-compat

## What

Bump `pi-file-watcher` to version `1.3.0` and pin `@mariozechner/pi-coding-agent` as a minimum peer dependency at `>=0.62.0`.

## Why

Pi `0.62.0` (released 2026-03-23) introduced breaking changes to the extension API. A compatibility audit confirmed our extension uses none of the affected APIs, so no code changes are required. However, we need to document the minimum compatible pi version in `package.json` so consumers and package managers can enforce it.

## Goals

- `package.json` version field reads `1.3.0`
- `peerDependencies["@mariozechner/pi-coding-agent"]` reads `>=0.62.0`
- No changes to `extensions/file-watcher.ts`

## Non-goals

- No new features
- No changes to extension logic or behaviour
- No changes to README prose (the install/usage content remains accurate)

## Impact

Anyone running `pi-file-watcher` on pi `<0.62.0` will receive a peer dependency warning from their package manager. Users on `>=0.62.0` are unaffected.
