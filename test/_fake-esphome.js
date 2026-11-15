'use strict'

// A fake ESPHome Bluetooth proxy (native API, plaintext) in front of a simulated kettle.
// Messages use the client library's own protobuf classes, except the GATT service list,
// which is encoded the way ESPHome's firmware does it (each 64-bit half of a 128-bit
// UUID as its own field, not packed; esphome/components/api/api_pb2.cpp).

const net = require('net')
const { pb, id_to_type } = require('@2colors/esphome-native-api/lib/utils/messages')
const { CHARACTERISTICS } = require('../lib/stagg-ble-protocol')
const { HANDLES } = require('./_kettle-sim')

const CONNECT_V3_WITHOUT_CACHE = 5
const DISCONNECT = 1

function varint (value) {
  let v = BigInt(value)
  const out = []
  do {
    let byte = Number(v & 0x7fn)
    v >>= 7n
    if (v) byte |= 0x80
    out.push(byte)
  } while (v)
  return out
}
const tag = (field, wire) => varint((field << 3) | wire)
const uint = (field, value) => [...tag(field, 0), ...varint(value)]
const nested = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes]
const uuidHalves = (field, uuid) => {
  const hex = uuid.replace(/-/g, '')
  return [...uint(field, BigInt('0x' + hex.slice(0, 16))), ...uint(field, BigInt('0x' + hex.slice(16)))]
}

function servicesResponse (address) {
  const characteristic = (name, properties, notify) => nested(3, [
    ...uuidHalves(1, CHARACTERISTICS[name]),
    ...uint(2, HANDLES[name]),
    ...uint(3, properties),
    ...(notify ? nested(4, [...uint(2, HANDLES[name] + 1), ...uint(3, 0x2902)]) : []),
  ])
  const genericAccess = nested(2, [...uint(2, 1), ...nested(3, [...uint(2, 3), ...uint(3, 0x02), ...uint(5, 0x2a00)]), ...uint(4, 0x1800)])
  const kettle = nested(2, [
    // The service UUID itself is made up; the client only looks at characteristics.
    ...uuidHalves(1, '2291c4b0-5d7f-4477-a88b-b266edb97142'),
    ...uint(2, 0x0f),
    ...characteristic('status', 0x12, true),
    ...characteristic('control', 0x0a, false),
    ...characteristic('settings', 0x1a, true),
    ...characteristic('console', 0x18, true),
    ...characteristic('firmware', 0x02, false),
  ])
  return Uint8Array.from([...uint(1, address), ...genericAccess, ...kettle])
}

function advertisementData (name) {
  const nameBytes = [...Buffer.from(name)]
  return Uint8Array.from([0x02, 0x01, 0x06, nameBytes.length + 1, 0x09, ...nameBytes])
}

class FakeEsphomeProxy {
  constructor (kettle, { address = 0x80f3da6d5946, name = 'EKG-5946' } = {}) {
    this.kettle = kettle
    this.address = address
    this.name = name
    this.log = []
    this.sockets = new Set()
    this.server = net.createServer((socket) => this._accept(socket))
  }

  listen () {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port)))
  }

  close () {
    for (const socket of this.sockets) socket.destroy()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  // Drops every API connection, as a rebooting proxy would.
  dropApi () {
    for (const socket of this.sockets) socket.destroy()
  }

  // The kettle drops its Bluetooth link.
  dropDevice () {
    for (const socket of this.sockets) {
      if (!socket.state.connected) continue
      this._stopDevice(socket)
      this._send(socket, 'BluetoothDeviceConnectionResponse', (m) => {
        m.setAddress(this.address); m.setConnected(false); m.setError(19)
      })
    }
  }

  _accept (socket) {
    socket.state = { buffer: Buffer.alloc(0), connected: false, notifyRequested: false, advertising: null, frames: null }
    this.sockets.add(socket)
    socket.on('data', (data) => {
      socket.state.buffer = Buffer.concat([socket.state.buffer, data])
      this._drain(socket)
    })
    socket.on('close', () => {
      this._stopDevice(socket)
      clearInterval(socket.state.advertising)
      this.sockets.delete(socket)
    })
    socket.on('error', () => {})
  }

  _drain (socket) {
    for (;;) {
      const buf = socket.state.buffer
      if (buf.length < 3) return
      if (buf[0] !== 0) throw new Error('fake proxy: not a plaintext frame')
      let offset = 1
      const read = () => {
        let result = 0
        let shift = 0
        for (;;) {
          if (offset >= buf.length) return null
          const byte = buf[offset++]
          result += (byte & 0x7f) * 2 ** shift
          shift += 7
          if (!(byte & 0x80)) return result
        }
      }
      const length = read()
      const id = read()
      if (length === null || id === null || offset + length > buf.length) return
      const payload = buf.subarray(offset, offset + length)
      socket.state.buffer = buf.subarray(offset + length)
      const type = id_to_type[id]
      this._handle(socket, type, pb[type].deserializeBinary(payload))
    }
  }

  _sendRaw (socket, id, bytes) {
    if (socket.destroyed) return
    socket.write(Buffer.from([0, ...varint(bytes.length), ...varint(id), ...bytes]))
  }

  _send (socket, type, fill) {
    const message = new pb[type]()
    if (fill) fill(message)
    this._sendRaw(socket, Number(pb[type].id), message.serializeBinary())
  }

  _stopDevice (socket) {
    socket.state.connected = false
    socket.state.notifyRequested = false
    clearInterval(socket.state.frames)
    socket.state.frames = null
  }

  _gattError (socket, handle, error = 0x0a) {
    this._send(socket, 'BluetoothGATTErrorResponse', (m) => { m.setAddress(this.address); m.setHandle(handle); m.setError(error) })
  }

  _handle (socket, type, msg) {
    const entry = { type, ...msg.toObject() }
    this.log.push(entry)
    const address = this.address
    switch (type) {
      case 'HelloRequest':
        return this._send(socket, 'HelloResponse', (m) => {
          m.setApiVersionMajor(1); m.setApiVersionMinor(14); m.setServerInfo('fake 2026.11'); m.setName('kettle-proxy')
        })
      case 'PingRequest':
        return this._send(socket, 'PingResponse')
      case 'DisconnectRequest':
        this._send(socket, 'DisconnectResponse')
        return socket.end()
      case 'SubscribeBluetoothLEAdvertisementsRequest':
        clearInterval(socket.state.advertising)
        socket.state.advertising = setInterval(() => {
          this._send(socket, 'BluetoothLERawAdvertisementsResponse', (m) => {
            const adv = new pb.BluetoothLERawAdvertisement()
            adv.setAddress(address); adv.setRssi(-63); adv.setAddressType(0); adv.setData(advertisementData(this.name))
            m.addAdvertisements(adv)
          })
        }, 10)
        return
      case 'UnsubscribeBluetoothLEAdvertisementsRequest':
        clearInterval(socket.state.advertising)
        socket.state.advertising = null
        return
      case 'BluetoothDeviceRequest': {
        const ok = Number(msg.getAddress()) === address
        if (msg.getRequestType() === DISCONNECT) {
          this._stopDevice(socket)
          return this._send(socket, 'BluetoothDeviceConnectionResponse', (m) => { m.setAddress(msg.getAddress()); m.setConnected(false) })
        }
        const connected = ok && msg.getRequestType() === CONNECT_V3_WITHOUT_CACHE && msg.getHasAddressType() && msg.getAddressType() === 0
        socket.state.connected = connected
        return this._send(socket, 'BluetoothDeviceConnectionResponse', (m) => {
          m.setAddress(msg.getAddress()); m.setConnected(connected); m.setMtu(connected ? 23 : 0); m.setError(connected ? 0 : 133)
        })
      }
      case 'BluetoothGATTGetServicesRequest':
        this._sendRaw(socket, 71, servicesResponse(address))
        return this._send(socket, 'BluetoothGATTGetServicesDoneResponse', (m) => m.setAddress(address))
      case 'BluetoothGATTReadRequest': {
        const handle = msg.getHandle()
        let data
        if (handle === HANDLES.firmware) data = Buffer.from(`${this.kettle.firmware}\0`, 'latin1')
        else if (handle === HANDLES.settings) data = settings(this.kettle.targetC)
        else return this._gattError(socket, handle)
        return this._send(socket, 'BluetoothGATTReadResponse', (m) => { m.setAddress(address); m.setHandle(handle); m.setData(Uint8Array.from(data)) })
      }
      case 'BluetoothGATTWriteRequest': {
        const handle = msg.getHandle()
        const data = Buffer.from(msg.getData_asU8())
        const name = Object.keys(HANDLES).find(k => HANDLES[k] === handle)
        this.kettle.writes.push({ name, data, response: msg.getResponse() })
        if (!name || this.kettle.failWrites.has(name)) return this._gattError(socket, handle, 133)
        if (name === 'console' && data.toString() === '2\n') this.kettle.press()
        if (name === 'settings' && data.readUInt16LE(0) & 0x0002) this.kettle.targetC = (data.readUInt16LE(4) & 0x7fff) / 2
        return this._send(socket, 'BluetoothGATTWriteResponse', (m) => { m.setAddress(address); m.setHandle(handle) })
      }
      case 'BluetoothGATTNotifyRequest':
        if (msg.getHandle() === HANDLES.status && msg.getEnable()) socket.state.notifyRequested = true
        return this._send(socket, 'BluetoothGATTNotifyResponse', (m) => { m.setAddress(address); m.setHandle(msg.getHandle()) })
      case 'BluetoothGATTWriteDescriptorRequest': {
        const handle = msg.getHandle()
        const data = Buffer.from(msg.getData_asU8())
        this._send(socket, 'BluetoothGATTWriteResponse', (m) => { m.setAddress(address); m.setHandle(handle) })
        // Like an ESPHome v3 connection: frames only flow once the client has both asked
        // for notifications and written the descriptor itself.
        if (handle === HANDLES.status + 1 && data.equals(Buffer.from([1, 0])) && socket.state.notifyRequested) {
          clearInterval(socket.state.frames)
          socket.state.frames = setInterval(() => {
            if (!socket.state.connected || this.kettle.silent) return
            const frame = this.kettle.frame()
            this._send(socket, 'BluetoothGATTNotifyDataResponse', (m) => {
              m.setAddress(address); m.setHandle(HANDLES.status); m.setData(Uint8Array.from(frame))
            })
          }, this.kettle.frameMs)
        }
        return
      }
      default:
    }
  }
}

function settings (targetC) {
  const bytes = Buffer.alloc(17)
  bytes.writeUInt16LE(0x0302, 0)
  bytes.writeUInt16LE(0x8000 | Math.round(targetC * 2), 4)
  return bytes
}

module.exports = { FakeEsphomeProxy }
