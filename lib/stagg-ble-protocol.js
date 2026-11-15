'use strict'

// Fellow Stagg EKG Pro over Bluetooth LE (firmware 1.2.26). GATT characteristics:
//   B1  notify  16-byte quick status: state, current and target temperature
//   B4  write   session/interval control (type 3 = quick-status interval in ms)
//   B5  read/write/notify  the same 17-byte settings record as the native HTTP `/api`
//   B6  write   console; "2\n" is one press of the dial, which toggles power
//   B7  read    firmware version string
// Wire formats as documented by bramboe/stagg-ekg-plus-ha (protocol.py, kettle_ble.py).

const { decodeTemperature, decodeSettings, targetTempPayload } = require('./stagg-ekg-pro-native-client')

const characteristic = (n) => `2291c4b${n}-5d7f-4477-a88b-b266edb97142`
const CHARACTERISTICS = {
    status: characteristic(1),
    control: characteristic(4),
    settings: characteristic(5),
    console: characteristic(6),
    firmware: characteristic(7),
}

// How a kettle advertises itself (Home Assistant's manifest matchers, minus Espressif's
// generic provisioning service, which other ESP32 devices advertise too).
const ADVERTISED_NAME = /^(EKG|Stagg|Fellow)/i
const ADVERTISED_SERVICE = '7aebf330-6cb1-46e4-b23b-7cc2262c605e'

const STATES = { 0: 'S_OFF', 1: 'S_STARTUPTOTEMPR', 5: 'S_HEAT', 7: 'S_HOLD', 8: 'S_NOWATER' }
const HEATING = new Set(['S_STARTUPTOTEMPR', 'S_HEAT', 'S_HOLD'])
const IDLE = new Set(['S_OFF', 'S_NOWATER'])

// The only power command: one dial press. It toggles, so it is only ever sent after a
// fresh status shows the kettle in the opposite state.
const POWER_TOGGLE = Buffer.from('2\n')
const POWER_ON_FROM = new Set(['S_OFF'])
const POWER_OFF_FROM = new Set(['S_HEAT', 'S_HOLD'])

function decodeStatus (bytes) {
    if (!bytes || bytes.length !== 16 || bytes.every(b => b === 0)) {
        throw new Error(`expected a non-empty 16-byte status record, got ${bytes ? bytes.length : 0} bytes`)
    }
    const code = bytes[6]
    // uint16 (°C + 50) * 10; zero means no probe reading, i.e. the kettle is off its base.
    const rawTemp = bytes[12] | (bytes[13] << 8)
    const currentTemp = rawTemp ? (rawTemp - 500) / 10 : null
    if (currentTemp !== null && !(currentTemp >= 0 && currentTemp <= 120)) {
        throw new Error(`status temperature out of range: ${currentTemp}`)
    }
    // Low byte of the setpoint; byte 7 bit 3 says it is in Celsius half degrees.
    const targetTemp = decodeTemperature(bytes[14] | (bytes[7] & 0x08 ? 0x8000 : 0))
    if (!(targetTemp >= 40 && targetTemp <= 100)) throw new Error(`status setpoint out of range: ${targetTemp}`)
    const state = STATES[code] || `UNKNOWN_${code}`
    return {
        state,
        heating: HEATING.has(state) ? true : IDLE.has(state) ? false : null,
        currentTemp,
        targetTemp,
        lifted: currentTemp === null,
        noWater: state === 'S_NOWATER',
        sequence: bytes[4] | (bytes[5] << 8),
        settingsRevision: bytes[8],
    }
}

// A frame counts only if its sequence moved forward (mod 2^16), so duplicated or
// reordered notifications never refresh the evidence a power command relies on.
function sequenceAdvanced (previous, next) {
    if (previous === null || previous === undefined) return true
    const delta = (next - previous + 0x10000) % 0x10000
    return delta > 0 && delta < 0x8000
}

function controlPayload (type, flags, value) {
    const bytes = Buffer.alloc(8)
    bytes.writeUInt16LE(type, 0)
    bytes.writeUInt16LE(flags, 2)
    bytes.writeUInt32LE(value >>> 0, 4)
    return bytes
}

// A new random session id resets the kettle's command ordinal (type 0).
const sessionPayload = (random32) => controlPayload(0, 0, random32)
// Type 3 sets the quick-status (B1) notification interval only.
const statusIntervalPayload = (ms) => controlPayload(3, 1, ms)

function parseFirmware (bytes) {
    const text = Buffer.from(bytes).toString('latin1')
    const end = text.indexOf('\0')
    return (end === -1 ? text : text.slice(0, end)).trim()
}

// Bluetooth writes are only validated on 1.2.26 (1.2.24's protocol is unknown).
function writesSupported (firmware) {
    return String(firmware || '').split(/\s+/)[0] === '1.2.26'
}

function isKettleAdvertisement (adv) {
    if (!adv) return false
    if (ADVERTISED_NAME.test(adv.name || '')) return true
    return (adv.serviceUuids || []).some(uuid => String(uuid).toLowerCase() === ADVERTISED_SERVICE)
}

function macToNumber (mac) {
    const hex = String(mac || '').replace(/[^0-9a-f]/gi, '')
    if (hex.length !== 12) throw new Error(`not a Bluetooth address: ${mac}`)
    return parseInt(hex, 16)
}

function numberToMac (value) {
    return Number(value).toString(16).padStart(12, '0').toUpperCase().match(/../g).join(':')
}

module.exports = {
    CHARACTERISTICS,
    POWER_TOGGLE,
    POWER_ON_FROM,
    POWER_OFF_FROM,
    decodeStatus,
    decodeSettings,
    targetTempPayload,
    sequenceAdvanced,
    sessionPayload,
    statusIntervalPayload,
    parseFirmware,
    writesSupported,
    isKettleAdvertisement,
    macToNumber,
    numberToMac,
}
