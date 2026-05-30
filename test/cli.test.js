'use strict'

const assert = require('assert')
const StaggEKGProClient = require('../lib/stagg-ekg-pro-client')
const { test, banner } = require('./_harness')

banner('cli.test.js')
const client = new StaggEKGProClient('http://kettle.local')

test('encode: state', () => {
  assert.strictEqual(client._encode('state'), 'state')
})

test('encode: setstate S_Heat', () => {
  assert.strictEqual(client._encode('setstate S_Heat'), 'setstate+S_Heat')
})

test('encode: setsetting settempr 205', () => {
  assert.strictEqual(client._encode('setsetting settempr 205'), 'setsetting+settempr+205')
})

test('encode: ss S_StartupToTempr', () => {
  assert.strictEqual(client._encode('ss S_StartupToTempr'), 'ss+S_StartupToTempr')
})
