# Design: version-pin-compat

## Approach

Two field edits in `package.json`. No other files change.

### version field

Change `"version": "1.2.0"` → `"version": "1.3.0"`.

Rationale: semver minor bump. The public contract (extension behaviour, commands, flags) is unchanged. The only observable difference is the pinned peer dependency range, which is additive metadata for consumers.

### peerDependencies

Change `"@mariozechner/pi-coding-agent": "*"` → `"@mariozechner/pi-coding-agent": ">=0.62.0"`.

Rationale: `*` provided no compatibility signal. `>=0.62.0` is the first release where we have verified full compatibility after a breaking-change release. The range is open-ended (`>=`) rather than a caret range because pi does not follow strict semver for extension-API stability — pinning an exact or caret range would unnecessarily block users on future pi releases.

### Why not a major bump?

No extension code changes. No API changes. Consumers need no migration. `1.3.0` correctly signals "same package, now with a tighter peer requirement".

## Risks

None. `package.json` metadata only.

## Alternatives rejected

- `^0.62.0` — too restrictive; would block future pi minor/patch releases unnecessarily.
- `>=0.62.0 <1.0.0` — pi is already past `1.0.0` conceptually; this would falsely limit range.
- Version `2.0.0` — unjustified; no breaking change in our own package's public interface.
