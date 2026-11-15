'use strict'

// The platform's `native` accessory as HomeKit sees it, with a minimal stand-in for the
// Homebridge API: on/off over Bluetooth (fake ESPHome proxy + simulated kettle), and the
// refusal without Bluetooth. The kettle's Wi-Fi `/temp` is a local HTTP server.

const assert = require('assert')
const http = require('http')
const EventEmitter = require('events')
const plugin = require('../index')
const { SimulatedKettle } = require('./_kettle-sim')
const { FakeEsphomeProxy } = require('./_fake-esphome')
const { test, banner } = require('./_harness')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function until (what, condition, ms = 5000) {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

class HapStatusError extends Error {
  constructor (status) {
    super(`HAP status ${status}`)
    this.hapStatus = status
  }
}
const HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402, RESOURCE_BUSY: -70403, NOT_ALLOWED_IN_CURRENT_STATE: -70412 }

class FakeCharacteristic {
  constructor (name) {
    this.name = name
    this.updates = []
  }
  setProps (props) { this.props = props; return this }
  onGet (fn) { this.get = fn; return this }
  onSet (fn) { this.set = fn; return this }
  updateValue (value) { this.updates.push(value); return this }
}
class FakeService {
  constructor () { this.characteristics = new Map() }
  getCharacteristic (type) {
    if (!this.characteristics.has(type)) this.characteristics.set(type, new FakeCharacteristic(type))
    return this.characteristics.get(type)
  }
  setCharacteristic (type, value) { this.getCharacteristic(type).value = value; return this }
  updateCharacteristic (type, value) { this.getCharacteristic(type).updateValue(value); return this }
}
class FakeAccessory {
  constructor (name, UUID) {
    this.displayName = name
    this.UUID = UUID
    this.context = {}
    this.services = new Map([['AccessoryInformation', new FakeService()]])
  }
  getService (type) { return this.services.get(type) }
  addService (type) { const s = new FakeService(); this.services.set(type, s); return s }
}

function homebridge () {
  const api = new EventEmitter()
  const names = ['Manufacturer', 'Model', 'SerialNumber', 'FirmwareRevision', 'CurrentHeatingCoolingState',
    'TargetHeatingCoolingState', 'TargetTemperature', 'CurrentTemperature', 'TemperatureDisplayUnits']
  api.hap = {
    Service: { AccessoryInformation: 'AccessoryInformation', Thermostat: 'Thermostat' },
    Characteristic: Object.fromEntries(names.map(n => [n, n])),
    HapStatusError,
    HAPStatus,
    uuid: { generate: (name) => `uuid-${name}` },
  }
  api.platformAccessory = FakeAccessory
  api.accessories = []
  api.registerPlatform = (pluginName, alias, Platform) => { api.Platform = Platform }
  api.registerPlatformAccessories = (p, a, accessories) => api.accessories.push(...accessories)
  api.updatePlatformAccessories = () => {}
  api.unregisterPlatformAccessories = () => {}
  plugin(api)
  return api
}

const log = Object.assign((...args) => log.lines.push(['log', ...args]), {
  lines: [],
  info: (m) => log.lines.push(['info', m]),
  warn: (m) => log.lines.push(['warn', m]),
  error: (m) => log.lines.push(['error', m]),
  debug: (m) => log.lines.push(['debug', m]),
})

function launch (kettleConfig) {
  const api = homebridge()
  new api.Platform(log, { platform: 'StaggKettle', kettles: [kettleConfig] }, api) // eslint-disable-line no-new
  api.emit('didFinishLaunching')
  const thermostat = api.accessories[0].getService('Thermostat')
  return { api, thermostat, char: (name) => thermostat.getCharacteristic(name) }
}

let wifi
let wifiUrl
const kettle = new SimulatedKettle({ frameMs: 20 })
const fake = new FakeEsphomeProxy(kettle)

banner('homekit.test.js: on/off from HomeKit')

test('setup: the kettle on Wi-Fi and behind a Bluetooth proxy', async () => {
  wifi = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ temp: 40.5, temp_set: 96, state: 'S_Off' }))
  })
  await new Promise(resolve => wifi.listen(0, '127.0.0.1', resolve))
  wifiUrl = `http://127.0.0.1:${wifi.address().port}`
})

test('without bluetooth: on is refused and HomeKit is put back', async () => {
  const { api, char } = launch({ name: 'Wi-Fi only', connection: 'native', url: wifiUrl })
  try {
    await until('the first Wi-Fi reading', () => char('CurrentTemperature').updates.length > 0)
    await assert.rejects(char('TargetHeatingCoolingState').set(1),
      (err) => err.hapStatus === HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE)
    assert.ok(log.lines.some(l => l[0] === 'warn' && /add `bluetooth`/.test(l[1])))
  } finally {
    api.emit('shutdown')
  }
})

test('with bluetooth: on and off from HomeKit press the dial once each', async () => {
  const port = await fake.listen()
  const { api, char } = launch({
    name: 'Kettle',
    connection: 'native',
    url: wifiUrl,
    bluetooth: { proxy: '127.0.0.1', port },
  })
  try {
    await until('the Bluetooth link', () => log.lines.some(l => l[0] === 'info' && /connected to the kettle 80:F3:DA:6D:59:46/.test(l[1])))
    await char('TargetHeatingCoolingState').set(1)
    assert.strictEqual(char('TargetHeatingCoolingState').get(), 1, 'reads the pending target while confirming')
    await until('heating in HomeKit', () => char('CurrentHeatingCoolingState').updates.at(-1) === 1)
    await until('the confirmation', () => log.lines.some(l => l[0] === 'info' && /reports heating/.test(l[1])))

    await until('S_HEAT', () => kettle.state === 'S_HEAT')
    await char('TargetHeatingCoolingState').set(0)
    await until('off in HomeKit', () => char('CurrentHeatingCoolingState').updates.at(-1) === 0)
    assert.strictEqual(kettle.writes.filter(w => w.name === 'console').length, 2)
  } finally {
    api.emit('shutdown')
  }
})

test('with bluetooth: the target temperature goes over Bluetooth', async () => {
  const { api, char } = launch({
    name: 'Kettle 2',
    connection: 'native',
    url: wifiUrl,
    bluetooth: { proxy: '127.0.0.1', port: fake.server.address().port },
  })
  try {
    await until('a Bluetooth status', () => log.lines.filter(l => /connected to the kettle/.test(l[1])).length >= 2)
    await until('fresh', () => char('TargetTemperature').updates.length > 0)
    await sleep(100)
    await char('TargetTemperature').set(85)
    assert.strictEqual(kettle.targetC, 85)
    assert.strictEqual(char('TargetTemperature').get(), 85)
  } finally {
    api.emit('shutdown')
  }
})

test('with bluetooth: off its base, on is refused and nothing is sent', async () => {
  const { api, char } = launch({
    name: 'Kettle 3',
    connection: 'native',
    url: wifiUrl,
    bluetooth: { proxy: '127.0.0.1', port: fake.server.address().port },
  })
  try {
    await until('a Bluetooth status', () => log.lines.filter(l => /connected to the kettle/.test(l[1])).length >= 3)
    await sleep(100)
    kettle.tempC = null
    await sleep(100)
    const before = kettle.writes.filter(w => w.name === 'console').length
    await assert.rejects(char('TargetHeatingCoolingState').set(1),
      (err) => err.hapStatus === HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE)
    assert.strictEqual(kettle.writes.filter(w => w.name === 'console').length, before)
    assert.ok(log.lines.some(l => l[0] === 'warn' && /off its base/.test(l[1])))
  } finally {
    api.emit('shutdown')
    kettle.tempC = 40
  }
})

test('teardown', async () => {
  await sleep(50)
  await fake.close()
  await new Promise(resolve => wifi.close(resolve))
})
