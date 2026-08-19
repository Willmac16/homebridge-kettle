'use strict'

const assert = require('assert')
const { test } = require('node:test')
const { getPollIntervals, startTempPolling } = require('../lib/temperature-polling')

test('invalid intervals fall back to defaults', () => {
  assert.deepStrictEqual(getPollIntervals({
    pollIntervalHeating: 0,
    pollIntervalIdle: NaN,
  }), {
    heating: 10000,
    idle: 1800000,
  })
})

test('idle temperature is published immediately and then at its own interval', async () => {
  let time = 0
  let scheduled
  const idleTemperatureDue = []
  const update = async (idleDue) => {
    idleTemperatureDue.push(idleDue)
    return { isHeating: 0, temperatureUpdated: idleDue }
  }

  startTempPolling({ debug() {} }, {
    pollIntervalHeating: 10,
    pollIntervalIdle: 30,
  }, update, {
    now: () => time,
    setTimeout: (fn, delay) => { scheduled = { fn, delay } },
  })

  await Promise.resolve()
  assert.deepStrictEqual(idleTemperatureDue, [true])
  assert.strictEqual(scheduled.delay, 10)

  time = 10
  scheduled.fn()
  await Promise.resolve()
  assert.deepStrictEqual(idleTemperatureDue, [true, false])

  time = 30
  scheduled.fn()
  await Promise.resolve()
  assert.deepStrictEqual(idleTemperatureDue, [true, false, true])
})

test('state continues polling at the heating interval while idle', async () => {
  let scheduled
  let polls = 0
  const states = [0, 1]

  startTempPolling({ debug() {} }, {
    pollIntervalHeating: 10,
    pollIntervalIdle: 1800000,
  }, async () => ({
    isHeating: states[polls++],
    temperatureUpdated: true,
  }), {
    now: () => 0,
    setTimeout: (fn, delay) => { scheduled = { fn, delay } },
  })

  await Promise.resolve()
  assert.strictEqual(scheduled.delay, 10)
  scheduled.fn()
  await Promise.resolve()
  assert.strictEqual(polls, 2)
  assert.strictEqual(scheduled.delay, 10)
})
