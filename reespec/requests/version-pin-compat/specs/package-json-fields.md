# Spec: package.json fields

## Capability

`package.json` carries the correct version and peer dependency constraint after the update.

---

## Scenario 1: version field is 1.3.0

**GIVEN** the `package.json` file in the project root  
**WHEN** its `version` field is read  
**THEN** it equals `"1.3.0"`

---

## Scenario 2: peerDependency is pinned to >=0.62.0

**GIVEN** the `package.json` file in the project root  
**WHEN** `peerDependencies["@mariozechner/pi-coding-agent"]` is read  
**THEN** it equals `">=0.62.0"`

---

## Scenario 3: extension source file is untouched

**GIVEN** `extensions/file-watcher.ts`  
**WHEN** its content is compared to the pre-change content  
**THEN** it is byte-for-byte identical (no lines added, removed, or modified)
