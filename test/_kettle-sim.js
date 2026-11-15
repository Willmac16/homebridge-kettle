'use strict'

// A simulated Stagg EKG Pro on firmware 1.2.26, as seen through a GATT link with the
// interface of lib/esphome-ble-proxy.js. Frames are built from the documented layout,
// not captured from a kettle.

const EventEmitter = require('events')
const { CHARACTERISTICS } = require('../lib/stagg-ble-protocol')

const CODES = { S_OFF: 0, S_STARTUPTOTEMPR: 1, S_HEAT: 5, S_HOLD: 7, S_NOWATER: 8 }

function statusFrame ({ sequence = 1, state = 'S_OFF', tempC = 40, targetC = 96, celsius = true, revision = 1 }) {
  const bytes = Buffer.alloc(16)
  bytes.writeUInt16LE(sequence & 0xffff, 4)
  bytes[6] = typeof state === 'number' ? state : CODES[state]
  bytes[7] = celsius ? 0x08 : 0
  bytes[8] = revision
  bytes.writeUInt16LE(tempC === null ? 0 : Math.round((tempC + 50) * 10), 12)
  bytes[14] = celsius ? Math.round(targetC * 2) & 0xff : Math.round(targetC * 1.8 + 32)
  return bytes
}

function settingsRecord (targetC) {
  const bytes = Buffer.alloc(17)
  bytes.writeUInt16LE(0x0302, 0) // units present + Celsius, target present
  bytes.writeUInt16LE(0x8000 | Math.round(targetC * 2), 4)
  return bytes
}

const HANDLES = { status: 0x10, control: 0x20, settings: 0x30, console: 0x40, firmware: 0x50 }

class SimulatedKettle extends EventEmitter {
  constructor ({ firmware = '1.2.26', state = 'S_OFF', tempC = 40, targetC = 96, frameMs = 15, offPresses = 1, heatAfterMs = 30 } = {}) {
    super()
    this.firmware = firmware
    this.state = state
    this.tempC = tempC
    this.targetC = targetC
    this.frameMs = frameMs
    this.offPresses = offPresses // presses an off needs (2 = the first only leaves the brew-time screen)
    this.heatAfterMs = heatAfterMs
    this.sequence = 0
    this.writes = []
    this.ignorePresses = false
    this.failWrites = new Set()
    this.duplicateFrames = false
    this.silent = false
    this._pressesWhileOn = 0
  }

  frame () {
    if (!this.duplicateFrames) this.sequence = (this.sequence + 1) & 0xffff
    return statusFrame({ sequence: this.sequence, state: this.state, tempC: this.tempC, targetC: this.targetC })
  }

  press () {
    if (this.ignorePresses) return
    if (this.state === 'S_OFF') {
      this.state = 'S_STARTUPTOTEMPR'
      this._pressesWhileOn = 0
      setTimeout(() => { if (this.state === 'S_STARTUPTOTEMPR') this.state = 'S_HEAT' }, this.heatAfterMs)
    } else if (this.state === 'S_HEAT' || this.state === 'S_HOLD') {
      this._pressesWhileOn++
      if (this._pressesWhileOn >= this.offPresses) this.state = 'S_OFF'
    }
  }
}

// The link a StaggEKGProBleClient talks to.
class SimulatedLink extends EventEmitter {
  constructor (kettle, { address = 0x80f3da6d5946, name = 'EKG-5946', advertise = true } = {}) {
    super()
    this.kettle = kettle
    this.address = address
    this.name = name
    this.advertise = advertise
    this.ready = false
    this.device = null
    this.connects = 0
    this._timer = null
    this._onStatus = null
  }

  start () {
    this.ready = true
    setImmediate(() => this.emit('ready'))
  }

  stop () {
    this.ready = false
    this._drop()
  }

  findDevice ({ address, match, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const adv = { address: this.address, addressType: 0, name: this.name, rssi: -61, serviceUuids: [] }
      if (this.advertise && (address !== null ? address === this.address : match(adv))) {
        setTimeout(() => resolve(adv), 5)
      } else {
        setTimeout(() => reject(new Error('no advertisement')), timeoutMs)
      }
    })
  }

  async connectDevice (address, addressType) {
    if (address !== this.address || addressType !== 0) throw new Error('wrong address')
    this.connects++
    this.device = { address }
    const char = (name, props, cccd = null) => [CHARACTERISTICS[name], {
      uuid: CHARACTERISTICS[name],
      handle: HANDLES[name],
      properties: { read: false, write: false, writeWithoutResponse: false, notify: false, indicate: false, ...props },
      cccd,
    }]
    return new Map([
      char('status', { notify: true, read: true }, HANDLES.status + 1),
      char('control', { read: true, write: true }),
      char('settings', { read: true, write: true, notify: true }, HANDLES.settings + 1),
      char('console', { write: true, notify: true }, HANDLES.console + 1),
      char('firmware', { read: true }),
    ])
  }

  async disconnectDevice () {
    this._drop()
  }

  _drop () {
    clearInterval(this._timer)
    this._timer = null
    this.device = null
    this._onStatus = null
  }

  // The kettle dropping the link on its own.
  loseDevice () {
    this._drop()
    this.emit('deviceLost', new Error('the kettle disconnected (error 19)'))
  }

  async read (handle) {
    if (!this.device) throw new Error('not connected')
    if (handle === HANDLES.firmware) return Buffer.from(`${this.kettle.firmware}\0\0\0`, 'latin1')
    if (handle === HANDLES.settings) return settingsRecord(this.kettle.targetC)
    throw new Error(`unexpected read of ${handle}`)
  }

  async write (handle, data) {
    if (!this.device) throw new Error('not connected')
    const name = Object.keys(HANDLES).find(k => HANDLES[k] === handle)
    this.kettle.writes.push({ name, data: Buffer.from(data) })
    if (this.kettle.failWrites.has(name)) throw new Error('write on handle failed with GATT error 133')
    if (name === 'console' && Buffer.from(data).toString() === '2\n') this.kettle.press()
    if (name === 'settings') {
      const raw = Buffer.from(data)
      if (raw.readUInt16LE(0) & 0x0002) this.kettle.targetC = (raw.readUInt16LE(4) & 0x7fff) / 2
    }
  }

  async subscribe (characteristic, onData) {
    if (characteristic.handle !== HANDLES.status) throw new Error('only status is subscribed')
    this._onStatus = onData
    clearInterval(this._timer)
    this._timer = setInterval(() => {
      if (this._onStatus && !this.kettle.silent) this._onStatus(this.kettle.frame())
    }, this.kettle.frameMs)
  }
}

module.exports = { SimulatedKettle, SimulatedLink, statusFrame, settingsRecord, HANDLES, CODES }
