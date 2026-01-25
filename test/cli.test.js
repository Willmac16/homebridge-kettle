'use strict'

const assert = require('assert')
const { StaggEKGAccessory } = require('../index')
const { test, banner } = require('./_harness')

function makeInstance() {
  return Object.create(StaggEKGAccessory.prototype)
}

banner('cli.test.js')
const accessory = makeInstance()

test('encode: state', () => {
  assert.strictEqual(accessory._encodeCliCommand('state'), 'state')
})

test('encode: setstate S_Heat', () => {
  assert.strictEqual(accessory._encodeCliCommand('setstate S_Heat'), 'setstate+S_Heat')
})

test('encode: setsetting settempr 205', () => {
  assert.strictEqual(accessory._encodeCliCommand('setsetting settempr 205'), 'setsetting+settempr+205')
})

test('encode: ss S_StartupToTempr', () => {
  assert.strictEqual(accessory._encodeCliCommand('ss S_StartupToTempr'), 'ss+S_StartupToTempr')
})
