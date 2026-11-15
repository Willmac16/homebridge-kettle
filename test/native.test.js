'use strict'

const assert = require('assert')
const StaggEKGProNativeClient = require('../lib/stagg-ekg-pro-native-client')
const { parseStatus, decodeSettings, decodeTemperature, targetTempPayload } = StaggEKGProNativeClient
const { test, banner } = require('./_harness')

banner('native.test.js: /temp')

test('status: idle kettle (firmware 1.2.26 capture)', () => {
  const s = parseStatus('{"temp":40.73,"temp_set":40.00,"state":"S_Off","pwm":-10,"timestamp":1107333612}')
  assert.deepStrictEqual(s, { state: 'S_OFF', heating: false, currentTemp: 40.73, targetTemp: 40, lifted: false, noWater: false })
})

test('status: heating states', () => {
  for (const state of ['S_Heat', 'S_HOLD', 'S_StartupToTempr']) {
    assert.strictEqual(parseStatus(`{"temp":80,"temp_set":96,"state":"${state}"}`).heating, true)
  }
})

test('status: no water is not heating', () => {
  const s = parseStatus('{"temp":30,"temp_set":96,"state":"S_NOWATER"}')
  assert.strictEqual(s.heating, false)
  assert.strictEqual(s.noWater, true)
})

test('status: unknown state leaves heating unknown', () => {
  assert.strictEqual(parseStatus('{"temp":30,"temp_set":96,"state":"S_Menu"}').heating, null)
})

test('status: bare nan while lifted', () => {
  const s = parseStatus('{"temp":nan,"temp_set":96.5,"state":"S_Off"}')
  assert.strictEqual(s.lifted, true)
  assert.strictEqual(s.currentTemp, null)
  assert.strictEqual(s.targetTemp, 96.5)
})

test('status: the muted CLI form is rejected', () => {
  assert.throws(() => parseStatus('<form action="cli" method="GET"></form>'), /invalid \/temp response/)
})

test('status: missing keys are rejected', () => {
  assert.throws(() => parseStatus('{"temp":40}'), /invalid \/temp response/)
})

test('status: out-of-range setpoint is rejected', () => {
  assert.throws(() => parseStatus('{"temp":40,"temp_set":120,"state":"S_Off"}'), /temp_set out of range/)
})

banner('native.test.js: settings record')

test('temperature: Celsius half degrees', () => {
  assert.strictEqual(decodeTemperature(0x8000 | 193), 96.5)
})

test('temperature: whole Fahrenheit', () => {
  assert.strictEqual(decodeTemperature(212), 100)
})

test('payload: selects only the target, Celsius half degrees', () => {
  const p = targetTempPayload(96.5)
  assert.strictEqual(p.length, 17)
  assert.deepStrictEqual(Array.from(p.slice(0, 6)), [0x02, 0x00, 0x00, 0x00, 193, 0x80])
  assert.ok(p.slice(6).every(b => b === 0))
})

test('payload: rounds to half degrees', () => {
  const p = targetTempPayload(85.3)
  assert.strictEqual(p[4] | (p[5] << 8), 0x8000 | 171)
})

test('payload: rejects out-of-range targets', () => {
  assert.throws(() => targetTempPayload(39.5), /between 40 and 100/)
  assert.throws(() => targetTempPayload(100.5), /between 40 and 100/)
  assert.throws(() => targetTempPayload(NaN), /between 40 and 100/)
})

test('settings: decodes target and units', () => {
  const raw = new Uint8Array(17)
  raw[0] = 0x02
  raw[1] = 0x03
  raw[4] = 193
  raw[5] = 0x80
  assert.deepStrictEqual(decodeSettings(raw), { targetTemp: 96.5, units: 'C' })
})

test('settings: Fahrenheit units flag', () => {
  const raw = new Uint8Array(17)
  raw[0] = 0x02
  raw[1] = 0x01
  raw[4] = 205
  assert.strictEqual(decodeSettings(raw).units, 'F')
  assert.ok(Math.abs(decodeSettings(raw).targetTemp - 96.11) < 0.01)
})

test('settings: wrong length is rejected', () => {
  assert.throws(() => decodeSettings(new Uint8Array(16)), /17-byte/)
})

banner('native.test.js: url')

test('url: trailing slash and /cli are dropped', () => {
  assert.strictEqual(new StaggEKGProNativeClient('http://10.0.5.51/').root, 'http://10.0.5.51')
  assert.strictEqual(new StaggEKGProNativeClient('http://10.0.5.51/cli?cmd=state').root, 'http://10.0.5.51')
})
