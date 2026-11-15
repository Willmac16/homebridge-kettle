'use strict'

// Firmware 1.2.26 mutes the HTTP CLI (`/cli` answers with its input form only) and
// offers a small native API instead:
//   GET  /temp                         JSON status: {"temp", "temp_set", "state", ...}
//   GET  /api?i=0,p=0,d=0,t=3,s=1      17-byte binary settings record
//   POST /api?i=0,p=0,d=0,t=3,s=1      17-byte record that selects the fields to write
// There is no power (on/off) command over Wi-Fi, and the kettle turns its Wi-Fi off
// while it heats or holds. Wire formats as documented by bramboe/stagg-ekg-plus-ha
// (native_http.py, protocol.py).

const SETTINGS_PATH = '/api?i=0,p=0,d=0,t=3,s=1'
const SETTINGS_LENGTH = 17
const SELECT_TARGET = 0x0002
const UNITS_CELSIUS = 0x0200
const CELSIUS_HALF_DEGREES = 0x8000
const HEATING_STATES = new Set(['S_STARTUPTOTEMPR', 'S_HEAT', 'S_HOLD'])
const IDLE_STATES = new Set(['S_OFF', 'S_NOWATER'])

class StaggEKGProNativeClient {
    constructor (url, timeoutMs = 5000) {
        this.root = String(url || '')
            .replace(/[?#].*$/, '')
            .replace(/\/+$/, '')
            .replace(/\/cli$/, '')
        this.timeoutMs = timeoutMs
        this._statusInflight = null
        this._writes = Promise.resolve()
    }

    async _request (path, options = {}) {
        if (!/^https?:\/\/[^/]/.test(this.root)) {
            throw new Error('Missing kettle url; set config.url to the kettle base URL.')
        }
        const res = await fetch(this.root + path, { signal: AbortSignal.timeout(this.timeoutMs), ...options })
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`)
        return res
    }

    // Concurrent callers share one request.
    status () {
        if (!this._statusInflight) {
            this._statusInflight = this._request('/temp')
                .then(res => res.text())
                .then(parseStatus)
                .finally(() => { this._statusInflight = null })
        }
        return this._statusInflight
    }

    async settings () {
        const res = await this._request(SETTINGS_PATH)
        return decodeSettings(new Uint8Array(await res.arrayBuffer()))
    }

    // Writes only the target temperature, then reads the settings back until they match.
    setTargetTemp (tempC) {
        const run = () => this._setTargetTemp(tempC)
        const result = this._writes.then(run, run)
        this._writes = result.catch(() => {})
        return result
    }

    async _setTargetTemp (tempC) {
        const payload = targetTempPayload(tempC)
        const expected = Math.round(tempC * 2) / 2
        await this._request(SETTINGS_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: payload,
        }).then(res => res.arrayBuffer())
        const deadline = Date.now() + 8000
        let actual = null
        while (Date.now() < deadline) {
            actual = (await this.settings()).targetTemp
            if (Math.abs(actual - expected) <= 0.01) return actual
            await new Promise(resolve => setTimeout(resolve, 500))
        }
        throw new Error(`target temperature not confirmed: asked for ${expected}, kettle reports ${actual}`)
    }
}

// The firmware writes a bare `nan` for the probe while the kettle is off its base.
function parseStatus (body) {
    const text = String(body || '').replace(/("temp"\s*:\s*)nan(?=\s*[,}])/i, '$1null')
    let raw
    try {
        raw = JSON.parse(text)
    } catch (err) {
        throw new Error(`invalid /temp response: ${text.trim().slice(0, 120)}`)
    }
    if (!raw || typeof raw !== 'object' || !('temp' in raw) || !('temp_set' in raw) || !('state' in raw)) {
        throw new Error(`invalid /temp response: ${text.trim().slice(0, 120)}`)
    }
    const state = String(raw.state).toUpperCase()
    if (!state.startsWith('S_')) throw new Error(`unrecognised state: ${raw.state}`)
    const lifted = raw.temp === null
    const currentTemp = lifted ? null : finiteIn(raw.temp, 0, 120, 'temp')
    const targetTemp = finiteIn(raw.temp_set, 40, 100, 'temp_set')
    const heating = HEATING_STATES.has(state) ? true : IDLE_STATES.has(state) ? false : null
    return { state, heating, currentTemp, targetTemp, lifted, noWater: state === 'S_NOWATER' }
}

function finiteIn (value, low, high, name) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) {
        throw new Error(`${name} out of range: ${value}`)
    }
    return value
}

// Bit 15 set: Celsius in half degrees; clear: whole degrees Fahrenheit.
function decodeTemperature (raw) {
    return raw & CELSIUS_HALF_DEGREES ? (raw & 0x7fff) / 2 : (raw - 32) / 1.8
}

function decodeSettings (bytes) {
    if (!bytes || bytes.length !== SETTINGS_LENGTH) {
        throw new Error(`expected a ${SETTINGS_LENGTH}-byte settings record, got ${bytes ? bytes.length : 0}`)
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const mask = view.getUint16(0, true)
    const targetTemp = decodeTemperature(view.getUint16(4, true))
    if (!(targetTemp >= 40 && targetTemp <= 100)) throw new Error(`setpoint out of range: ${targetTemp}`)
    return { targetTemp, units: mask & UNITS_CELSIUS ? 'C' : 'F' }
}

function targetTempPayload (tempC) {
    if (typeof tempC !== 'number' || !Number.isFinite(tempC) || tempC < 40 || tempC > 100) {
        throw new Error('target temperature must be between 40 and 100 °C')
    }
    const bytes = new Uint8Array(SETTINGS_LENGTH)
    const view = new DataView(bytes.buffer)
    view.setUint16(0, SELECT_TARGET, true)
    view.setUint16(4, CELSIUS_HALF_DEGREES | Math.round(tempC * 2), true)
    return bytes
}

module.exports = StaggEKGProNativeClient
module.exports.parseStatus = parseStatus
module.exports.decodeSettings = decodeSettings
module.exports.decodeTemperature = decodeTemperature
module.exports.targetTempPayload = targetTempPayload
