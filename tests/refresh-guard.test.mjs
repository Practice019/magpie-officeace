import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { makeDeadRefreshGuard, deadRefreshKey, DEAD_REFRESH_TTL_MS } from "../src/refresh-guard.mjs"

test("dead refresh guard: cooldown, expiry, and no raw token on disk", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "officeace-guard-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "officeace-dead-refresh.json")
  let clock = 1_000_000
  const guard = makeDeadRefreshGuard({ file, now: () => clock })
  const cred = { refreshToken: "one-time-refresh-token" }

  assert.equal(guard.isDead(cred), false)
  assert.equal(guard.markDead(cred), true)
  assert.equal(guard.isDead(cred), true)
  assert.equal(guard.isDead({ refreshToken: "another-token" }), false)

  const raw = fs.readFileSync(file, "utf8")
  assert.equal(raw.includes("one-time-refresh-token"), false)
  assert.deepEqual(Object.keys(JSON.parse(raw)), [deadRefreshKey(cred)])

  clock += DEAD_REFRESH_TTL_MS + 1
  assert.equal(guard.isDead(cred), false)
})

test("dead refresh guard: no token or no file is a no-op", () => {
  const guard = makeDeadRefreshGuard({ file: "" })
  assert.equal(guard.isDead({}), false)
  assert.equal(guard.markDead({}), false)
  assert.equal(guard.isDead({ refreshToken: "x" }), false)
  assert.equal(guard.markDead({ refreshToken: "x" }), false)
})
