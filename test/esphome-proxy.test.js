'use strict'

// The Bluetooth client end to end: the real ESPHome API client library over TCP, against
// a fake proxy (./_fake-esphome.js) in front of a simulated kettle.

const assert = require('assert')
const EsphomeBleProxy = require('../lib/esphome-ble-proxy')
const StaggEKGProBleClient = require('../lib/stagg-ekg-pro-ble-client')
const { SimulatedKettle, HANDLES } = require('./_kettle-sim')
const { FakeEsphomeProxy } = require('./_fake-esphome')
const { test, banner } = require('./_harness')

const timing = {
  freshMs: 300,
  stateTimeoutMs: 400,
  writeTimeoutMs: 1000,
  transitionTimeoutMs: 800,
  offFollowupDelayMs: 60,
  settingsVerifyMs: 500,
  settingsPollMs: 20,
  findTimeoutMs: 1000,
  retryMs: [50, 100],
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function until (what, condition, ms = 3000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

let fake
let client
let kettle
const events = []

banner('esphome-proxy.test.js: through a fake ESPHome Bluetooth proxy')

test('connects: hello, scan, v3 connect with address type, notifications with the descriptor written', async () => {
  kettle = new SimulatedKettle({ frameMs: 20 })
  fake = new FakeEsphomeProxy(kettle)
  const port = await fake.listen()
  const link = new EsphomeBleProxy({ host: '127.0.0.1', port, reconnectMs: 100, timeoutMs: 2000 })
  client = new StaggEKGProBleClient(link, { timing, random32: () => 7 })
  for (const name of ['found', 'connected', 'connectFailed', 'disconnected', 'warning']) {
    client.on(name, (...args) => events.push([name, ...args]))
  }
  client.start()
  await until('a fresh status', () => client.fresh)

  const types = fake.log.map(m => m.type)
  assert.strictEqual(types[0], 'HelloRequest')
  assert.ok(!types.includes('AuthenticationRequest'), 'no password login on API 1.12+')
  assert.ok(types.includes('UnsubscribeBluetoothLEAdvertisementsRequest'), 'stops scanning once found')
  const connect = fake.log.find(m => m.type === 'BluetoothDeviceRequest')
  assert.deepStrictEqual(
    { address: Number(connect.address), requestType: connect.requestType, hasAddressType: connect.hasAddressType, addressType: connect.addressType },
    { address: 0x80f3da6d5946, requestType: 5, hasAddressType: true, addressType: 0 })
  const descriptor = fake.log.find(m => m.type === 'BluetoothGATTWriteDescriptorRequest')
  assert.strictEqual(descriptor.handle, HANDLES.status + 1)
  assert.strictEqual(Buffer.from(descriptor.data, 'base64').toString('hex'), '0100')
  assert.deepStrictEqual(kettle.writes.map(w => [w.name, w.data.toString('hex'), w.response]), [
    ['control', '0000000007000000', true],
    ['control', '03000100f4010000', true],
  ])
  assert.strictEqual(client.firmware, '1.2.26')
  assert.strictEqual(events.find(e => e[0] === 'found')[1].name, 'EKG-5946')
})

test('switches on with one acknowledged dial press', async () => {
  const result = await client.setPower(true)
  assert.strictEqual(result.sent, true)
  assert.strictEqual((await result.confirmed).presses, 1)
  const press = kettle.writes.filter(w => w.name === 'console')
  assert.strictEqual(press.length, 1)
  assert.strictEqual(press[0].data.toString(), '2\n')
  assert.strictEqual(press[0].response, true)
})

test('sets the target temperature and reads it back', async () => {
  assert.strictEqual(await client.setTargetTemp(88), 88)
  assert.strictEqual(kettle.targetC, 88)
})

test('switches off from heating', async () => {
  await until('heating', () => client.status.state === 'S_HEAT')
  const result = await client.setPower(false)
  assert.strictEqual((await result.confirmed).presses, 1)
  assert.strictEqual(kettle.state, 'S_OFF')
})

test('a GATT error on the press fails at once, uncertain, without a retry', async () => {
  kettle.failWrites.add('console')
  const before = kettle.writes.filter(w => w.name === 'console').length
  const started = Date.now()
  await assert.rejects(client.setPower(true), (err) => err.code === 'uncertain' && /GATT error 133/.test(err.message))
  assert.ok(Date.now() - started < 1000)
  assert.strictEqual(kettle.writes.filter(w => w.name === 'console').length, before + 1)
  kettle.failWrites.clear()
})

test('reconnects when the kettle drops the Bluetooth link', async () => {
  const connects = () => fake.log.filter(m => m.type === 'BluetoothDeviceRequest' && m.requestType === 5).length
  const before = connects()
  fake.dropDevice()
  await until('the drop to be noticed', () => !client.fresh)
  await until('a fresh status again', () => client.fresh)
  assert.strictEqual(connects(), before + 1)
  assert.ok(events.some(e => e[0] === 'disconnected' && /error 19/.test(e[1])))
})

test('reconnects when the proxy itself goes away and comes back', async () => {
  const hellos = () => fake.log.filter(m => m.type === 'HelloRequest').length
  const before = hellos()
  fake.dropApi()
  await until('the drop to be noticed', () => !client.fresh)
  await until('a fresh status again', () => client.fresh, 5000)
  assert.strictEqual(hellos(), before + 1)
})

test('stops cleanly', async () => {
  client.stop()
  await sleep(50)
  await fake.close()
  assert.strictEqual(client.fresh, false)
})
