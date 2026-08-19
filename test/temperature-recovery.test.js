'use strict'

const assert = require('assert')
const { createTemperatureRecovery } = require('../lib/temperature-recovery')
const { test, banner } = require('./_harness')

banner('temperature-recovery.test.js')

test('retries until a returned kettle has a valid temperature', async () => {
  let scheduled
  let schedules = 0
  let checks = 0
  const results = [false, true]
  const recovery = createTemperatureRecovery({ debug() {} }, async () => {
    checks += 1
    return results.shift()
  }, {
    delay: 10,
    setTimeout: (fn, delay) => {
      schedules += 1
      scheduled = { fn, delay }
      return schedules
    },
    clearTimeout() {},
  })

  recovery.start()
  recovery.start()
  assert.strictEqual(schedules, 1)
  assert.strictEqual(scheduled.delay, 10)

  await scheduled.fn()
  assert.strictEqual(checks, 1)
  assert.strictEqual(schedules, 2)

  await scheduled.fn()
  assert.strictEqual(checks, 2)
  assert.strictEqual(schedules, 2)
})

test('stop cancels a pending recovery check', () => {
  let cancellations = 0
  const recovery = createTemperatureRecovery({ debug() {} }, async () => true, {
    setTimeout: () => 123,
    clearTimeout: (timer) => {
      assert.strictEqual(timer, 123)
      cancellations += 1
    },
  })

  recovery.start()
  recovery.stop()
  assert.strictEqual(cancellations, 1)
})
