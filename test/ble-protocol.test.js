'use strict'

const assert = require('assert')
const p = require('../lib/stagg-ble-protocol')
const { statusFrame } = require('./_kettle-sim')
const { test, banner } = require('./_harness')

banner('ble-protocol.test.js: B1 status')

test('status: off, on the base, Celsius setpoint', () => {
  const s = p.decodeStatus(statusFrame({ sequence: 0x1234, state: 'S_OFF', tempC: 41.3, targetC: 96.5, revision: 9 }))
  assert.deepStrictEqual(s, {
    state: 'S_OFF', heating: false, currentTemp: 41.3, targetTemp: 96.5,
    lifted: false, noWater: false, sequence: 0x1234, settingsRevision: 9,
  })
})

test('status: heating, startup and hold count as heating', () => {
  for (const state of ['S_STARTUPTOTEMPR', 'S_HEAT', 'S_HOLD']) {
    assert.strictEqual(p.decodeStatus(statusFrame({ state })).heating, true, state)
  }
})

test('status: no water is idle, an unknown code is neither', () => {
  assert.strictEqual(p.decodeStatus(statusFrame({ state: 'S_NOWATER' })).heating, false)
  const s = p.decodeStatus(statusFrame({ state: 3 }))
  assert.strictEqual(s.state, 'UNKNOWN_3')
  assert.strictEqual(s.heating, null)
})

test('status: zero temperature means lifted', () => {
  const s = p.decodeStatus(statusFrame({ tempC: null }))
  assert.strictEqual(s.lifted, true)
  assert.strictEqual(s.currentTemp, null)
})

test('status: Fahrenheit setpoint', () => {
  const s = p.decodeStatus(statusFrame({ celsius: false, targetC: 100 }))
  assert.strictEqual(s.targetTemp, 100)
})

test('status: wrong length, all zeros and out-of-range values are rejected', () => {
  assert.throws(() => p.decodeStatus(Buffer.alloc(15, 1)), /16-byte/)
  assert.throws(() => p.decodeStatus(Buffer.alloc(16)), /16-byte/)
  assert.throws(() => p.decodeStatus(statusFrame({ targetC: 20 })), /setpoint out of range/)
  const hot = statusFrame({})
  hot.writeUInt16LE(2000, 12) // 150 °C
  assert.throws(() => p.decodeStatus(hot), /temperature out of range/)
})

test('sequence: only forward steps count, across the wrap', () => {
  assert.strictEqual(p.sequenceAdvanced(null, 5), true)
  assert.strictEqual(p.sequenceAdvanced(5, 6), true)
  assert.strictEqual(p.sequenceAdvanced(6, 6), false)
  assert.strictEqual(p.sequenceAdvanced(6, 5), false)
  assert.strictEqual(p.sequenceAdvanced(0xffff, 0), true)
  assert.strictEqual(p.sequenceAdvanced(0, 0xffff), false)
})

banner('ble-protocol.test.js: commands and identity')

test('power: one dial press', () => {
  assert.deepStrictEqual([...p.POWER_TOGGLE], [0x32, 0x0a])
})

test('control: session and 500 ms status interval records', () => {
  assert.strictEqual(p.sessionPayload(0xdeadbeef).toString('hex'), '00000000efbeadde')
  assert.strictEqual(p.statusIntervalPayload(500).toString('hex'), '03000100f4010000')
})

test('firmware: NUL-terminated string, writes only on 1.2.26', () => {
  assert.strictEqual(p.parseFirmware(Buffer.from('1.2.26 SSP\0junk')), '1.2.26 SSP')
  assert.strictEqual(p.writesSupported('1.2.26 SSP'), true)
  assert.strictEqual(p.writesSupported('1.2.26'), true)
  assert.strictEqual(p.writesSupported('1.2.24'), false)
  assert.strictEqual(p.writesSupported('1.1.76SSP'), false)
  assert.strictEqual(p.writesSupported(null), false)
})

test('advertisement: matched by name or the kettle service, not by provisioning alone', () => {
  assert.strictEqual(p.isKettleAdvertisement({ name: 'EKG-5946' }), true)
  assert.strictEqual(p.isKettleAdvertisement({ name: '', serviceUuids: ['7AEBF330-6CB1-46E4-B23B-7CC2262C605E'] }), true)
  assert.strictEqual(p.isKettleAdvertisement({ name: 'PROV_1234', serviceUuids: ['021a9004-0382-4aea-bff4-6b3f1c5adfb4'] }), false)
})

test('address: MAC to number and back', () => {
  assert.strictEqual(p.macToNumber('80:f3:da:6d:59:46'), 0x80f3da6d5946)
  assert.strictEqual(p.numberToMac(0x80f3da6d5946), '80:F3:DA:6D:59:46')
  assert.throws(() => p.macToNumber('80:f3:da'), /not a Bluetooth address/)
})
