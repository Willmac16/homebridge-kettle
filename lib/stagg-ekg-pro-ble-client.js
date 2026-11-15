'use strict'

// Fellow Stagg EKG Pro over Bluetooth LE: a persistent connection that streams the
// kettle's quick status, plus on/off and target temperature. Port of the Bluetooth
// transport in bramboe/stagg-ekg-plus-ha (kettle_ble.py), keeping its safety rules:
//
// - Power is one dial press ("2\n" on B6), which toggles. It is only sent after a
//   status frame received after the request shows the kettle in the opposite state:
//   on only from S_OFF (and not while the kettle is off its base), off only from
//   S_HEAT or S_HOLD. Startup, fault, unknown or stale states send nothing.
// - A dispatched write is never retried and never sent another way. The one exception
//   is upstream's: switching off may need a second press, because the first one can
//   only leave the brew-time screen; it is sent once, after an acknowledged first
//   press and three newer frames that still show the kettle heating.
// - Writes are only sent to firmware 1.2.26, the version they were validated on.
// - A status counts as fresh for five seconds; duplicate or reordered frames
//   (by sequence number) never refresh it.
//
// `link` is a GATT link such as ./esphome-ble-proxy.js.

const EventEmitter = require('events')
const protocol = require('./stagg-ble-protocol')

const {
    CHARACTERISTICS, POWER_TOGGLE, POWER_ON_FROM, POWER_OFF_FROM,
    decodeStatus, decodeSettings, targetTempPayload, sequenceAdvanced,
    sessionPayload, statusIntervalPayload, parseFirmware, writesSupported,
    isKettleAdvertisement, macToNumber, numberToMac,
} = protocol

const DEFAULT_TIMING = {
    statusIntervalMs: 500,
    freshMs: 5000,
    stateTimeoutMs: 7000,
    writeTimeoutMs: 8000,
    transitionTimeoutMs: 15000,
    offFollowupDelayMs: 1500,
    settingsVerifyMs: 8000,
    settingsPollMs: 500,
    findTimeoutMs: 60000,
    retryMs: [5000, 15000, 30000, 60000],
}

// code: 'busy' | 'unavailable' (nothing sent) | 'refused' (nothing sent) | 'uncertain' (a write may have taken effect)
class KettleError extends Error {
    constructor (code, message) {
        super(message)
        this.code = code
    }
}

function withTimeout (promise, ms, what) {
    let timer
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

class StaggEKGProBleClient extends EventEmitter {
    constructor (link, { address = null, timing = {}, random32 = () => Math.floor(Math.random() * 0x100000000) } = {}) {
        super()
        this.link = link
        this.address = address ? macToNumber(address) : null
        this.timing = { ...DEFAULT_TIMING, ...timing }
        this.random32 = random32
        this.connected = false
        this.firmware = null
        this.status = null
        this.target = null
        this._chars = null
        this._generation = 0
        this._sequence = null
        this._frameAt = 0
        this._waiters = new Set()
        this._failures = 0
        this._retryTimer = null
        this._staleTimer = null
        this._establishing = false
        this._stopped = false
        this._powerBusy = false
        this._settingsQueue = Promise.resolve()

        link.on('ready', () => this._schedule(0))
        link.on('apiLost', () => this._lost('the connection to the Bluetooth proxy closed', false))
        link.on('deviceLost', (err) => this._lost(err.message, true))
        link.on('warning', (err) => this.emit('warning', err))
    }

    start () {
        this.link.start()
    }

    stop () {
        this._stopped = true
        clearTimeout(this._retryTimer)
        clearTimeout(this._staleTimer)
        this._rejectWaiters(new Error('stopped'))
        this.link.stop()
    }

    get fresh () {
        return this.connected && this.status !== null && Date.now() - this._frameAt <= this.timing.freshMs
    }

    get writable () {
        return writesSupported(this.firmware)
    }

    _schedule (ms) {
        clearTimeout(this._retryTimer)
        if (this._stopped) return
        this._retryTimer = setTimeout(() => this._establish(), ms)
    }

    _retryDelay () {
        const steps = this.timing.retryMs
        return steps[Math.min(this._failures, steps.length) - 1] || steps[0]
    }

    async _establish () {
        if (this._establishing || this._stopped || this.connected || !this.link.ready) return
        this._establishing = true
        try {
            if (!this.target) {
                const found = await this.link.findDevice({
                    address: this.address,
                    match: isKettleAdvertisement,
                    timeoutMs: this.timing.findTimeoutMs,
                })
                this.target = found
                this.emit('found', { address: numberToMac(found.address), name: found.name, rssi: found.rssi, pinned: this.address !== null })
            }
            const chars = await this.link.connectDevice(this.target.address, this.target.addressType)
            this._chars = requiredCharacteristics(chars)
            this.firmware = parseFirmware(await this.link.read(this._chars.firmware.handle))
            const generation = ++this._generation
            this._sequence = null
            this._frameAt = 0
            this.status = null
            await this.link.subscribe(this._chars.status, (raw) => this._onStatus(generation, raw))
            if (this.writable && this._chars.control) {
                await this.link.write(this._chars.control.handle, sessionPayload(this.random32()))
                await this.link.write(this._chars.control.handle, statusIntervalPayload(this.timing.statusIntervalMs))
            }
            if (this._stopped) throw new Error('stopped')
            this.connected = true
            this._failures = 0
            this.emit('connected', { address: numberToMac(this.target.address), firmware: this.firmware, writable: this.writable })
        } catch (err) {
            this.connected = false
            this._generation++
            await this.link.disconnectDevice().catch(() => {})
            if (this._stopped) return
            this._failures++
            this.emit('connectFailed', err, this._failures)
            if (this.link.ready) this._schedule(this._retryDelay())
        } finally {
            this._establishing = false
        }
    }

    _lost (reason, reconnect) {
        const wasConnected = this.connected
        this.connected = false
        this._generation++
        clearTimeout(this._staleTimer)
        this._rejectWaiters(new Error(reason))
        if (wasConnected) this.emit('disconnected', reason)
        if (reconnect && !this._stopped && this.link.ready) this._schedule(this.timing.retryMs[0])
    }

    _onStatus (generation, raw) {
        if (generation !== this._generation) return
        let status
        try {
            status = decodeStatus(raw)
        } catch (err) {
            // A malformed frame voids the evidence from earlier ones.
            this._frameAt = 0
            this.emit('warning', new Error(`ignored a status frame: ${err.message}`))
            return
        }
        if (!sequenceAdvanced(this._sequence, status.sequence)) return
        this._sequence = status.sequence
        this._frameAt = Date.now()
        this.status = status
        clearTimeout(this._staleTimer)
        this._staleTimer = setTimeout(() => {
            if (generation === this._generation && !this.fresh) this.emit('stale')
        }, this.timing.freshMs + 100)
        this.emit('status', status)
        for (const waiter of this._waiters) waiter.resolve(status)
    }

    // The next accepted status frame, received after this call.
    _nextFrame (timeoutMs) {
        let waiter
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => waiter.reject(Object.assign(new Error(`no status frame in ${timeoutMs} ms`), { timeout: true })), timeoutMs)
            waiter = {
                resolve: (value) => { clearTimeout(timer); this._waiters.delete(waiter); resolve(value) },
                reject: (err) => { clearTimeout(timer); this._waiters.delete(waiter); reject(err) },
            }
        })
        this._waiters.add(waiter)
        return promise
    }

    _rejectWaiters (err) {
        for (const waiter of [...this._waiters]) waiter.reject(err)
    }

    _requireWritable (what) {
        if (!this.connected) throw new KettleError('unavailable', 'no Bluetooth link to the kettle; nothing sent')
        if (!this.writable) throw new KettleError('unavailable', `Bluetooth writes are only validated on firmware 1.2.26, the kettle runs ${this.firmware}; nothing sent`)
        if (!this._chars[what]) throw new KettleError('unavailable', `the kettle offers no writable ${what} characteristic; nothing sent`)
    }

    // Resolves once the press is acknowledged: { sent: false } when the kettle is already
    // in the requested state, else { sent: true, confirmed } where `confirmed` settles when
    // a status frame shows the new state (or rejects with 'uncertain').
    async setPower (on) {
        if (this._powerBusy) throw new KettleError('busy', 'the previous on/off command is still being confirmed')
        this._powerBusy = true
        let handedOff = false
        try {
            this._requireWritable('console')
            const generation = this._generation
            let state
            try {
                state = await this._nextFrame(this.timing.stateTimeoutMs)
            } catch (err) {
                throw new KettleError('unavailable', `no fresh status from the kettle (${err.message}); nothing sent`)
            }
            if (state.heating === on) return { sent: false, state }
            const allowed = on ? POWER_ON_FROM : POWER_OFF_FROM
            if (!allowed.has(state.state)) {
                throw new KettleError('refused', `the kettle reports ${state.state}; switching it ${on ? 'on' : 'off'} from there isn't supported, nothing sent`)
            }
            if (on && state.lifted) throw new KettleError('refused', 'the kettle is off its base; nothing sent')
            if (generation !== this._generation) throw new KettleError('unavailable', 'the Bluetooth link changed; nothing sent')
            try {
                await withTimeout(this.link.write(this._chars.console.handle, POWER_TOGGLE), this.timing.writeTimeoutMs, 'dial press')
            } catch (err) {
                throw new KettleError('uncertain', `the dial press was not acknowledged (${err.message}); not retried`)
            }
            const confirmed = this._confirmPower(on, generation, Date.now())
                .finally(() => { this._powerBusy = false })
            handedOff = true
            return { sent: true, state, confirmed }
        } finally {
            if (!handedOff) this._powerBusy = false
        }
    }

    async _confirmPower (on, generation, acknowledgedAt) {
        const t = this.timing
        const deadline = acknowledgedAt + t.transitionTimeoutMs
        const wanted = on ? 'heating' : 'off'
        let presses = 1
        let samples = 0
        for (;;) {
            const timedOut = () => new KettleError('uncertain',
                `the kettle didn't report ${wanted} within ${Math.round(t.transitionTimeoutMs / 1000)} s; no further command sent`)
            const remaining = deadline - Date.now()
            if (remaining <= 0) throw timedOut()
            let state
            try {
                state = await this._nextFrame(remaining)
            } catch (err) {
                if (err.timeout && Date.now() >= deadline - 5) throw timedOut()
                throw new KettleError('uncertain', `lost the kettle's status before it reported ${wanted} (${err.message}); no further command sent`)
            }
            if (generation !== this._generation) {
                throw new KettleError('uncertain', `the Bluetooth link changed before the kettle reported ${wanted}; no further command sent`)
            }
            if (state.heating === on) return { presses, state }
            if (on) continue
            if (!POWER_OFF_FROM.has(state.state)) {
                throw new KettleError('uncertain', `the kettle went to ${state.state} instead of off; no further command sent`)
            }
            samples++
            if (presses === 1 && samples >= 3 && Date.now() - acknowledgedAt >= t.offFollowupDelayMs) {
                presses = 2
                try {
                    await withTimeout(this.link.write(this._chars.console.handle, POWER_TOGGLE), t.writeTimeoutMs, 'second dial press')
                } catch (err) {
                    throw new KettleError('uncertain', `the second dial press was not acknowledged (${err.message}); not retried`)
                }
            }
        }
    }

    // Writes only the target temperature, then reads the settings back until they match.
    setTargetTemp (tempC) {
        const run = () => this._setTargetTemp(tempC)
        const result = this._settingsQueue.then(run, run)
        this._settingsQueue = result.catch(() => {})
        return result
    }

    async _setTargetTemp (tempC) {
        const t = this.timing
        this._requireWritable('settings')
        if (!this.fresh) throw new KettleError('unavailable', 'no live Bluetooth status from the kettle; nothing sent')
        const payload = targetTempPayload(tempC)
        const expected = Math.round(tempC * 2) / 2
        const generation = this._generation
        try {
            await withTimeout(this.link.write(this._chars.settings.handle, payload), t.writeTimeoutMs, 'settings write')
        } catch (err) {
            throw new KettleError('uncertain', `the target temperature write was not acknowledged (${err.message}); not retried`)
        }
        const deadline = Date.now() + t.settingsVerifyMs
        let actual = null
        while (Date.now() < deadline && generation === this._generation) {
            try {
                actual = decodeSettings(await withTimeout(this.link.read(this._chars.settings.handle), t.writeTimeoutMs, 'settings read')).targetTemp
            } catch (err) {
                throw new KettleError('uncertain', `could not read the target temperature back (${err.message})`)
            }
            if (Math.abs(actual - expected) <= 0.01) return actual
            await sleep(t.settingsPollMs)
        }
        throw new KettleError('uncertain', `target temperature not confirmed: asked for ${expected} °C, kettle reports ${actual}`)
    }
}

function requiredCharacteristics (chars) {
    const get = (uuid) => chars.get(uuid) || null
    const status = get(CHARACTERISTICS.status)
    const firmware = get(CHARACTERISTICS.firmware)
    if (!status || !status.properties.notify) throw new Error('the kettle has no status characteristic (B1) to subscribe to; is this a Stagg EKG Pro?')
    if (!firmware || !firmware.properties.read) throw new Error('the kettle has no firmware characteristic (B7)')
    const writable = (c) => (c && c.properties.write ? c : null)
    const settings = get(CHARACTERISTICS.settings)
    return {
        status,
        firmware,
        settings: settings && settings.properties.read ? writable(settings) : null,
        console: writable(get(CHARACTERISTICS.console)),
        control: writable(get(CHARACTERISTICS.control)),
    }
}

module.exports = StaggEKGProBleClient
module.exports.KettleError = KettleError
module.exports.DEFAULT_TIMING = DEFAULT_TIMING
