'use strict'

const assert = require('assert')
const StaggEKGProBleClient = require('../lib/stagg-ekg-pro-ble-client')
const { SimulatedKettle, SimulatedLink } = require('./_kettle-sim')
const { test, banner } = require('./_harness')

// The real timings scaled down; the simulated kettle sends a frame every 15 ms.
const timing = {
  statusIntervalMs: 500,
  freshMs: 150,
  stateTimeoutMs: 200,
  writeTimeoutMs: 200,
  transitionTimeoutMs: 400,
  offFollowupDelayMs: 50,
  settingsVerifyMs: 200,
  settingsPollMs: 10,
  findTimeoutMs: 100,
  retryMs: [20, 40],
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function connected (kettleOptions = {}, clientOptions = {}, linkOptions = {}) {
  const kettle = new SimulatedKettle(kettleOptions)
  const link = new SimulatedLink(kettle, linkOptions)
  const client = new StaggEKGProBleClient(link, { timing, random32: () => 0x01020304, ...clientOptions })
  const events = []
  for (const name of ['found', 'connected', 'connectFailed', 'disconnected', 'stale']) {
    client.on(name, (...args) => events.push([name, ...args]))
  }
  client.on('warning', () => {})
  client.start()
  const deadline = Date.now() + 1000
  while (!client.fresh && Date.now() < deadline) await sleep(5)
  return { kettle, link, client, events }
}

const presses = (kettle) => kettle.writes.filter(w => w.name === 'console').length

banner('ble-client.test.js: connection')

test('finds the kettle by name, connects, and asks for 500 ms status frames', async () => {
  const { kettle, client, events } = await connected()
  try {
    assert.strictEqual(client.fresh, true)
    assert.strictEqual(client.firmware, '1.2.26')
    assert.deepStrictEqual(events.find(e => e[0] === 'found')[1], { address: '80:F3:DA:6D:59:46', name: 'EKG-5946', rssi: -61, pinned: false })
    assert.deepStrictEqual(kettle.writes.map(w => [w.name, w.data.toString('hex')]), [
      ['control', '0000000004030201'],
      ['control', '03000100f4010000'],
    ])
    assert.strictEqual(client.status.state, 'S_OFF')
  } finally {
    client.stop()
  }
})

test('a pinned address ignores the name', async () => {
  const { client, events } = await connected({}, { address: '80:F3:DA:6D:59:46' }, { name: 'something else' })
  try {
    assert.strictEqual(client.fresh, true)
    assert.strictEqual(events.find(e => e[0] === 'found')[1].pinned, true)
  } finally {
    client.stop()
  }
})

test('firmware other than 1.2.26: status only, no writes at all', async () => {
  const { kettle, client } = await connected({ firmware: '1.2.24' })
  try {
    assert.strictEqual(client.fresh, true)
    assert.strictEqual(client.writable, false)
    assert.deepStrictEqual(kettle.writes, [])
    await assert.rejects(client.setPower(true), (err) => err.code === 'unavailable' && /1\.2\.26/.test(err.message))
    await assert.rejects(client.setTargetTemp(90), (err) => err.code === 'unavailable')
    assert.deepStrictEqual(kettle.writes, [])
  } finally {
    client.stop()
  }
})

test('repeated frames do not keep the status fresh', async () => {
  const { kettle, client, events } = await connected()
  try {
    kettle.duplicateFrames = true
    await sleep(timing.freshMs + 150)
    assert.strictEqual(client.fresh, false)
    assert.ok(events.some(e => e[0] === 'stale'))
    await assert.rejects(client.setPower(true), (err) => err.code === 'unavailable')
    assert.strictEqual(presses(kettle), 0)
  } finally {
    client.stop()
  }
})

test('reconnects after the kettle drops the link', async () => {
  const { link, client, events } = await connected()
  try {
    link.loseDevice()
    assert.strictEqual(client.fresh, false)
    const deadline = Date.now() + 1000
    while (!client.fresh && Date.now() < deadline) await sleep(5)
    assert.strictEqual(client.fresh, true)
    assert.strictEqual(link.connects, 2)
    assert.ok(events.some(e => e[0] === 'disconnected'))
  } finally {
    client.stop()
  }
})

test('keeps looking when no kettle advertises', async () => {
  const { client, events } = await connected({}, {}, { advertise: false })
  try {
    await sleep(250)
    assert.strictEqual(client.fresh, false)
    assert.ok(events.filter(e => e[0] === 'connectFailed').length >= 2)
  } finally {
    client.stop()
  }
})

banner('ble-client.test.js: on/off')

test('on from S_OFF: one press, confirmed by a heating frame', async () => {
  const { kettle, client } = await connected()
  try {
    const result = await client.setPower(true)
    assert.strictEqual(result.sent, true)
    const { presses: count, state } = await result.confirmed
    assert.strictEqual(count, 1)
    assert.strictEqual(state.heating, true)
    assert.strictEqual(presses(kettle), 1)
    assert.strictEqual(kettle.writes.find(w => w.name === 'console').data.toString(), '2\n')
  } finally {
    client.stop()
  }
})

test('already in the requested state: nothing sent', async () => {
  const { kettle, client } = await connected({ state: 'S_HEAT' })
  try {
    const result = await client.setPower(true)
    assert.strictEqual(result.sent, false)
    assert.strictEqual(presses(kettle), 0)
  } finally {
    client.stop()
  }
})

test('off from S_HEAT and S_HOLD: one press', async () => {
  for (const state of ['S_HEAT', 'S_HOLD']) {
    const { kettle, client } = await connected({ state })
    try {
      const result = await client.setPower(false)
      assert.strictEqual((await result.confirmed).presses, 1, state)
      assert.strictEqual(kettle.state, 'S_OFF')
      assert.strictEqual(presses(kettle), 1)
    } finally {
      client.stop()
    }
  }
})

test('off when the first press only leaves the brew-time screen: one follow-up press', async () => {
  const { kettle, client } = await connected({ state: 'S_HEAT', offPresses: 2 })
  try {
    const result = await client.setPower(false)
    assert.strictEqual((await result.confirmed).presses, 2)
    assert.strictEqual(kettle.state, 'S_OFF')
    assert.strictEqual(presses(kettle), 2)
  } finally {
    client.stop()
  }
})

test('off that two presses do not reach: unconfirmed, never a third press', async () => {
  const { kettle, client } = await connected({ state: 'S_HEAT', offPresses: 3 })
  try {
    const result = await client.setPower(false)
    await assert.rejects(result.confirmed, (err) => err.code === 'uncertain' && /didn't report off/.test(err.message))
    assert.strictEqual(presses(kettle), 2)
  } finally {
    client.stop()
  }
})

test('on that the kettle ignores: unconfirmed after the timeout, one press only', async () => {
  const { kettle, client } = await connected()
  try {
    kettle.ignorePresses = true
    const result = await client.setPower(true)
    await assert.rejects(result.confirmed, (err) => err.code === 'uncertain')
    assert.strictEqual(presses(kettle), 1)
  } finally {
    client.stop()
  }
})

test('refused states send nothing: no water, unknown, startup, lifted', async () => {
  const cases = [
    [{ state: 'S_NOWATER' }, true],
    [{ state: 3 }, true],
    [{ state: 3 }, false],
    [{ state: 'S_STARTUPTOTEMPR' }, false],
    [{ state: 'S_OFF', tempC: null }, true],
  ]
  for (const [kettleOptions, on] of cases) {
    const { kettle, client } = await connected(kettleOptions)
    try {
      await assert.rejects(client.setPower(on), (err) => err.code === 'refused', JSON.stringify(kettleOptions))
      assert.strictEqual(presses(kettle), 0)
    } finally {
      client.stop()
    }
  }
})

test('a failed press is reported uncertain and not retried', async () => {
  const { kettle, client } = await connected()
  try {
    kettle.failWrites.add('console')
    await assert.rejects(client.setPower(true), (err) => err.code === 'uncertain' && /not retried/.test(err.message))
    assert.strictEqual(presses(kettle), 1)
  } finally {
    client.stop()
  }
})

test('losing the link while confirming: unconfirmed, nothing more sent', async () => {
  const { kettle, link, client } = await connected({ heatAfterMs: 1000 })
  try {
    kettle.ignorePresses = true
    const result = await client.setPower(true)
    link.loseDevice()
    await assert.rejects(result.confirmed, (err) => err.code === 'uncertain' && /lost the kettle's status/.test(err.message))
    assert.strictEqual(presses(kettle), 1)
  } finally {
    client.stop()
  }
})

test('a second command while one is being confirmed is busy', async () => {
  const { kettle, client } = await connected()
  try {
    kettle.ignorePresses = true
    const first = await client.setPower(true)
    await assert.rejects(client.setPower(true), (err) => err.code === 'busy')
    await assert.rejects(first.confirmed)
    assert.strictEqual(presses(kettle), 1)
  } finally {
    client.stop()
  }
})

banner('ble-client.test.js: target temperature')

test('target temperature: written, then read back', async () => {
  const { kettle, client } = await connected({ targetC: 96 })
  try {
    assert.strictEqual(await client.setTargetTemp(92.4), 92.5)
    assert.strictEqual(kettle.targetC, 92.5)
    const write = kettle.writes.find(w => w.name === 'settings').data
    assert.strictEqual(write.length, 17)
    assert.strictEqual(write.readUInt16LE(0), 0x0002)
    assert.strictEqual(write.readUInt16LE(4), 0x8000 | 185)
  } finally {
    client.stop()
  }
})

test('target temperature: out of range is rejected before anything is sent', async () => {
  const { kettle, client } = await connected()
  try {
    await assert.rejects(client.setTargetTemp(30), /between 40 and 100/)
    assert.strictEqual(kettle.writes.filter(w => w.name === 'settings').length, 0)
  } finally {
    client.stop()
  }
})
