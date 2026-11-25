import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { stsExpired } from "../src/credential.mjs"
import { makeStsFresh, persistRefreshedAuth } from "../src/sts-refresh.mjs"

const day = 24 * 60 * 60 * 1000

test("stsExpired reads both field spellings and treats past ISO strings as expired", () => {
  const past = new Date(Date.now() - day).toISOString()
  const future = new Date(Date.now() + day).toISOString()
  assert.equal(stsExpired({ expiresAt: past }), true)
  assert.equal(stsExpired({ expires_at: past }), true)
  assert.equal(stsExpired({ expiresAt: future }), false)
  assert.equal(stsExpired({}), false)
})

test("persistRefreshedAuth updates only the matching Huawei account", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "officeace-sts-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "plugin-auth.json")
  const old = { access: "OLD_AK", secret: "OLD_SK", refreshToken: "old-refresh", modelAppKey: "mk" }
  fs.writeFileSync(
    file,
    JSON.stringify({
      other: { refresh: "keep-me" },
      "officeace#abc": { refresh: "old-refresh", access: JSON.stringify(old), expires: 1 },
    }),
  )

  const ok = persistRefreshedAuth({
    authFile: file,
    oldRefresh: "old-refresh",
    next: { access: "NEW_AK", secret: "NEW_SK", refreshToken: "new-refresh", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  })
  assert.equal(ok, true)
  const all = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(all.other.refresh, "keep-me")
  assert.equal(all["officeace#abc"].refresh, "new-refresh")
  const access = JSON.parse(all["officeace#abc"].access)
  assert.equal(access.access, "NEW_AK")
  assert.equal(access.refreshToken, "new-refresh")
  assert.ok(all["officeace#abc"].expires > Date.now())
})

test("makeStsFresh only refreshes expired STS and respects cooldown", async () => {
  const expired = { refreshToken: "r1", expiresAt: new Date(Date.now() - day).toISOString() }
  const fresh = { refreshToken: "r1", expiresAt: new Date(Date.now() + day).toISOString(), access: "AK" }
  let calls = 0
  let persisted = 0
  const guard = {
    isDead: (c) => c?.refreshToken === "dead",
    markDead: () => {},
  }
  const ensure = makeStsFresh({
    authFile: "/tmp/not-used.json",
    guard,
    refresh: async (cred, persist) => {
      calls++
      persist?.({ ...cred })
      persisted++
      return { ...cred, access: "NEW_AK" }
    },
  })

  assert.equal(await ensure(fresh), fresh)
  assert.equal(calls, 0)

  const next = await ensure(expired)
  assert.equal(calls, 1)
  assert.equal(persisted, 1)
  assert.equal(next.access, "NEW_AK")

  calls = 0
  await ensure({ ...expired, refreshToken: "dead" })
  assert.equal(calls, 0)
})
