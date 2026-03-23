# Tasks: version-pin-compat

## Checklist

- [x] 1. Bump version to 1.3.0 and pin peerDependency

---

### 1. Bump version to 1.3.0 and pin peerDependency

- [x] **RED** — Assert current state: `package.json` `version` is NOT `1.3.0` and `peerDependencies["@mariozechner/pi-coding-agent"]` is NOT `>=0.62.0`. Run:
  ```bash
  node -e "const p = require('./package.json'); process.exitCode = (p.version === '1.3.0' || p.peerDependencies['@mariozechner/pi-coding-agent'] === '>=0.62.0') ? 0 : 1"
  ```
  Expect **exit code 1** (fields not yet updated).

- [x] **ACTION** — Edit `package.json`: set `"version"` to `"1.3.0"` and set `peerDependencies["@mariozechner/pi-coding-agent"]` to `">=0.62.0"`. No other files change.

- [x] **GREEN** — Verify both fields are correct and the extension file is untouched. Run:
  ```bash
  node -e "
    const p = require('./package.json');
    const assert = require('assert');
    assert.strictEqual(p.version, '1.3.0');
    assert.strictEqual(p.peerDependencies['@mariozechner/pi-coding-agent'], '>=0.62.0');
    console.log('OK');
  "
  ```
  Expect output `OK`. Also confirm `extensions/file-watcher.ts` has no uncommitted changes:
  ```bash
  git diff --exit-code extensions/file-watcher.ts
  ```
  Expect **exit code 0** (no changes).
