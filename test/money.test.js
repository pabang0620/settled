import test from 'node:test'
import assert from 'node:assert/strict'
import { holderPart, matchPart, minimumDue, roundHalfUp, toCents } from '../server/money.js'

test('S11: every allowed share splits the invoice exactly, with the biller-chosen rounding', () => {
  for (const total of [8240, 9999, 10001, 23680, 1, 7]) {
    for (const share of ['1/3', '1/2', '2/3']) {
      assert.equal(holderPart(total, share) + matchPart(total, share), total)
    }
  }
  assert.equal(holderPart(8240, '1/2'), 4120)
  assert.equal(matchPart(8240, '1/2'), 4120)
  assert.equal(holderPart(8240, '1/3'), 2747)
  assert.equal(matchPart(8240, '1/3'), 5493)
  assert.equal(holderPart(8240, '2/3'), 5493)
  assert.equal(matchPart(8240, '2/3'), 2747)
})

test('S11: roundHalfUp rounds .5 up and never uses floating point', () => {
  assert.equal(roundHalfUp(5, '1/2'), 3)
  assert.equal(roundHalfUp(1, '1/2'), 1)
  assert.equal(roundHalfUp(10, '1/3'), 3)
  assert.equal(roundHalfUp(11, '1/3'), 4)
  assert.equal(toCents('41.20'), 4120)
})

test('S11: holder part is never below the invoice minimum (same rounding function)', () => {
  for (let total = 1; total < 3000; total += 7) {
    const min = minimumDue(total, ['1/3', '1/2', '2/3'])
    for (const share of ['1/3', '1/2', '2/3']) assert.ok(holderPart(total, share) >= min)
  }
})
