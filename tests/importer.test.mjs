import test from "node:test"
import assert from "node:assert/strict"
import { OfficeAceAuthPlugin, CodeArtsAuthPlugin } from "../index.mjs"
import { generateDpopKeyPair } from "../src/crypto.mjs"
import { credentialOf as officeAceCredentialOf } from "../src/credential.mjs"
import { _internal as codeArts } from "../src/codearts/index.mjs"

process.env.MAGPIE_OFFICEACE_NO_AUTO_UPDATE = "1"

const { privateJwk } = await generateDpopKeyPair()
const expiry = "2030-01-01T00:00:00Z"
const jwt = (profile, suffix) => `mock.${Buffer.from(JSON.stringify({ user_profile: profile })).toString("base64url")}.${suffix}`
const officeAceRow = {
  provider: "officeace",
  access: "test-oa-ak",
  secret: "test-oa-sk",
  securityToken: "test-oa-st",
  refreshToken: jwt({ account_id: "test-oa-domain" }, "oa"),
  expiresAt: expiry,
  dpopPrivateJwk: privateJwk,
  user_phone: "123****4567",
}
const codeArtsRow = {
  provider: "codearts",
  access_key_id: "test-ca-ak",
  secret_access_key: "test-ca-sk",
  security_token: "test-ca-st",
  refresh_token: jwt({ principal_urn: "iam::test-ca-domain:user:test-ca-user" }, "ca"),
  expires_at: expiry,
  code_verifier: "v".repeat(64),
  dpop_private_key_jwk: privateJwk,
  session_id: "a".repeat(32),
}

const json = JSON.stringify
const { provider: caProvider, ...caFields } = codeArtsRow
const wrapped = (provider, accounts) => ({ provider, version: 1, accounts })

async function hooks(t) {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("意外的联网调用") })
  const set = t.mock.fn(() => { throw new Error("意外的宿主写入") })
  const client = { auth: { set } }
  const oa = (await OfficeAceAuthPlugin({ client }, { fetch })).auth
  const ca = (await CodeArtsAuthPlugin({ client }, { fetch })).auth
  t.after(() => {
    assert.equal(fetch.mock.callCount(), 0)
    assert.equal(set.mock.callCount(), 0)
  })
  return { oa, ca }
}

test("包入口暴露两个原生导入钩子，返回可被现有凭据读取器消费的登录结果", async (t) => {
  const { oa, ca } = await hooks(t)
  assert.match(oa.importFrom, /OfficeAce.*JSON/)
  assert.match(ca.importFrom, /CodeArts.*JSON/)
  const [office] = await oa.import([`\uFEFF${json(officeAceRow)}`])
  const [arts] = await ca.import([json(wrapped(caProvider, [caFields]))])
  assert.equal(office.type, "success")
  assert.equal(office.accountId, officeAceRow.user_phone)
  assert.equal(office.uid, "test-oa-domain")
  assert.equal(office.refresh, officeAceRow.refreshToken)
  assert.equal(office.expires, Date.parse(expiry))
  const officeCred = officeAceCredentialOf({ ...office, type: "oauth" })
  assert.deepEqual(officeCred.dpopPrivateJwk, privateJwk)
  assert.equal(officeCred.access, officeAceRow.access)
  assert.equal(arts.type, "success")
  assert.equal(arts.accountId, "iam::test-ca-domain:user:test-ca-user")
  assert.equal(arts.uid, arts.accountId)
  assert.equal(arts.refresh, codeArtsRow.refresh_token)
  assert.equal(arts.expires, Date.parse(expiry))
  const artsCred = codeArts.credentialOf({ ...arts, type: "oauth" })
  assert.deepEqual(artsCred.dpop_private_key_jwk, privateJwk)
  assert.equal(artsCred.code_verifier, codeArtsRow.code_verifier)
  assert.equal(artsCred.session_id, codeArtsRow.session_id)
})

test("逐条拒绝错供应商、错误格式或身份、无效 DPoP 和非官方网关；错误不回显输入", async (t) => {
  const { oa, ca } = await hooks(t)
  const marker = "synthetic-do-not-echo"
  const results = await oa.import([
    `${marker}\n${json(officeAceRow)}`,
    json(wrapped("codearts", [officeAceRow])),
    json([{ ...officeAceRow, provider: undefined }]),
    json({ provider: "officeace", version: 2, accounts: [officeAceRow] }),
    json([
      marker,
      { ...officeAceRow, oauth_client: "codearts-agent" },
      { ...officeAceRow, expiresAt: marker },
      { ...officeAceRow, accountId: marker },
      { ...officeAceRow, dpopPrivateJwk: { ...privateJwk, d: marker } },
      { ...officeAceRow, modelAppKey: marker },
      { ...officeAceRow, modelAppKey: marker, modelAppSecret: marker, maasBaseUrl: `https://${marker}.example` },
      { ...codeArtsRow, provider: "officeace" },
      { ...officeAceRow, modelAppKey: "test-model-key", modelAppSecret: "test-model-secret", maasBaseUrl: "modelgw-test.officeace.cn-southwest-2.huaweicloud-agentarts.com" },
    ]),
  ])
  assert.equal(results.length, 13)
  assert.equal(results.at(-1).type, "success")
  for (const [index, result] of results.slice(0, -1).entries()) {
    assert.equal(result.type, "failed")
    assert.deepEqual(Object.keys(result), ["type", "error"])
    assert.match(result.error, index < 4 ? /文件 \d/ : /文件 5 第 \d+ 条/)
    assert.ok(!result.error.includes(marker))
    assert.ok(!result.error.includes(officeAceRow.secret))
  }
  const badArts = await ca.import([json([
    { ...codeArtsRow, code_verifier: marker },
    { ...codeArtsRow, refresh_token: marker },
    { ...codeArtsRow, secret_access_key: "" },
    wrapped("codearts", [caFields]),
  ])])
  assert.deepEqual(badArts.map(({ type }) => type), Array(4).fill("failed"))
  assert.ok(!json(badArts).includes(marker))
})

test("批内不复用已接收的 UID、refresh token、STS AK 或 CodeArts 会话标识", async (t) => {
  const { oa, ca } = await hooks(t)
  const second = {
    ...officeAceRow,
    access: "test-oa-ak2",
    refreshToken: jwt({ account_id: "test-oa-domain2" }, "oa2"),
  }
  const results = await oa.import([
    json(officeAceRow),
    json([
      { ...second, refreshToken: jwt({ account_id: "test-oa-domain" }, "another") },
      { ...second, refreshToken: officeAceRow.refreshToken },
      { ...second, access: officeAceRow.access },
      second,
    ]),
  ])
  assert.deepEqual(results.map(({ type }) => type), ["success", "failed", "failed", "failed", "success"])
  assert.equal(results.at(-1).uid, "test-oa-domain2")

  const [firstArts, secondArts] = await ca.import([json([
    codeArtsRow,
    { ...codeArtsRow, access_key_id: "test-ca-ak2", refresh_token: jwt({ principal_urn: "test-ca-second" }, "ca2") },
  ])])
  assert.equal(firstArts.type, "success")
  assert.equal(secondArts.type, "failed")
  assert.match(secondArts.error, /同一会话标识/)
})

test("所有文件合计最多 100 条（含失败），取消不发布当前校验结果", async (t) => {
  const { oa, ca } = await hooks(t)
  const bounded = await oa.import(["broken", json(Array(102).fill(null)), json(officeAceRow)])
  assert.equal(bounded.length, 100)
  assert.ok(bounded.every(({ type }) => type === "failed"))
  assert.match(bounded.at(-1).error, /文件 2 第 99 条/)
  const aborted = new AbortController()
  aborted.abort("synthetic-cancel-reason")
  assert.deepEqual(await ca.import([json(codeArtsRow)], { signal: aborted.signal }), [])
  const during = new AbortController()
  const pending = ca.import([json(codeArtsRow), json(codeArtsRow)], { signal: during.signal })
  during.abort()
  assert.deepEqual(await pending, [])
})
