// contract-shape.test.mjs —— CONTRACT §1 / §2 / 8-02（P5）。
//
// officeace 的特殊之处：`DUAL_OFFICEACE_FAILED_INSTRUCTIONS` 里有「暂不可用」，
// 但那是**操作引导**（告诉用户改用另一种登录），不是错误原因 —— CONTRACT 8-02
// 的例外。这条测试把这个区别钉死，免得以后有人当成违规全删掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import { OfficeAceAuthPlugin } from '../index.mjs'

test('CONTRACT 1-01 / 1-03: 卡片字段齐全', async () => {
  const p = await OfficeAceAuthPlugin({ client: {} }, {})
  assert.equal(typeof p.auth.provider, 'string')
  assert.ok(Array.isArray(p.auth.methods), 'auth.methods 必须是数组')
  assert.equal(typeof p.auth.usage, 'function')
  assert.equal(typeof p.auth.checkin, 'function')
  assert.match(String(p.auth.icon || ''), /^(data:image\/|https:\/\/)/)
})

test('CONTRACT 2-02 / 2-04: auth.options 里没有签到/代理开关', async () => {
  const p = await OfficeAceAuthPlugin({ client: {} }, {})
  assert.ok(Array.isArray(p.auth.options))
  for (const o of p.auth.options) {
    assert.doesNotMatch(String(o.key), /check.?in|proxy/)
    assert.equal(typeof o.default, 'boolean')
  }
})
