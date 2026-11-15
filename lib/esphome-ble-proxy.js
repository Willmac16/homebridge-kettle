'use strict'

// A Bluetooth LE GATT link through an ESPHome Bluetooth proxy (`bluetooth_proxy:` with
// `active: true`), over ESPHome's native API (tcp/6053, plaintext or Noise with the
// device's `api: encryption: key:`). This is what Home Assistant uses when it has no
// Bluetooth adapter of its own near a device.
//
// One proxy connection serves one kettle. GATT operations run one at a time, each
// answered or failed by its own response, a GATT error for its handle, the kettle
// dropping the link, or a timeout. Nothing here retries a write.
//
// Events: 'ready' (API session up), 'apiLost' (API session closed; the proxy has dropped
// any Bluetooth link with it), 'deviceLost' (the kettle's link dropped), 'warning'.

const EventEmitter = require('events')

const CCCD = '00002902-0000-1000-8000-00805f9b34fb'
const PROPERTY = { read: 0x02, writeWithoutResponse: 0x04, write: 0x08, notify: 0x10, indicate: 0x20 }
const NOTIFY_ON = Uint8Array.from([0x01, 0x00])

class GattError extends Error {
    constructor (operation, handle, code) {
        super(`${operation} on handle ${handle} failed with GATT error ${code}`)
        this.code = code
    }
}

class EsphomeBleProxy extends EventEmitter {
    constructor ({ host, port = 6053, encryptionKey = '', timeoutMs = 10000, reconnectMs = 15000, Connection = null }) {
        super()
        if (!host) throw new Error('bluetooth.proxy: the ESPHome Bluetooth proxy host is required')
        this.host = host
        this.port = port
        this.encryptionKey = encryptionKey || ''
        this.timeoutMs = timeoutMs
        this.reconnectMs = reconnectMs
        this._Connection = Connection
        this.api = null
        this.ready = false
        this.device = null
        this._notify = new Map()
        this._queue = Promise.resolve()
    }

    start () {
        const Connection = this._Connection || require('@2colors/esphome-native-api').Connection
        const api = this.api = new Connection({
            host: this.host,
            port: this.port,
            encryptionKey: this.encryptionKey,
            clientInfo: 'homebridge-kettle-pro',
            reconnectInterval: this.reconnectMs,
        })
        api.on('authorized', () => {
            this.ready = true
            this.emit('ready')
        })
        api.on('unauthorized', () => {
            this.ready = false
            this._dropDevice('the connection to the Bluetooth proxy closed')
            this.emit('apiLost')
        })
        api.on('error', (err) => this.emit('warning', err))
        api.on('message.BluetoothDeviceConnectionResponse', (msg) => {
            if (this.device && Number(msg.address) === this.device.address && !msg.connected) {
                this._dropDevice(`the kettle disconnected (error ${msg.error || 0})`)
            }
        })
        api.on('message.BluetoothGATTNotifyDataResponse', (msg) => {
            if (!this.device || Number(msg.address) !== this.device.address) return
            const handler = this._notify.get(msg.handle)
            if (handler) handler(Buffer.from(msg.data || '', 'base64'))
        })
        api.on('message.BluetoothGATTErrorResponse', (msg) => this.emit('_gattError', msg))
        api.connect()
    }

    stop () {
        const api = this.api
        this.api = null
        this.ready = false
        this.device = null
        this._notify.clear()
        if (api) api.disconnect()
    }

    _dropDevice (reason) {
        if (!this.device) return
        this.device = null
        this._notify.clear()
        const err = new Error(reason)
        this.emit('_deviceLost', err)
        this.emit('deviceLost', err)
    }

    _requireReady () {
        if (!this.api || !this.ready) throw new Error(`not connected to the Bluetooth proxy at ${this.host}:${this.port}`)
    }

    // Waits for the first advertisement that `match` accepts (or that comes from `address`).
    findDevice ({ address = null, match = () => false, timeoutMs = 60000 }) {
        this._requireReady()
        const api = this.api
        return new Promise((resolve, reject) => {
            const onAdvertisement = (raw) => {
                const adv = {
                    address: Number(raw.address),
                    addressType: raw.addressType || 0,
                    name: raw.name || '',
                    rssi: raw.rssi,
                    serviceUuids: raw.serviceUuidsList || [],
                }
                if (address !== null ? adv.address === address : match(adv)) finish(null, adv)
            }
            const onLost = () => finish(new Error('the connection to the Bluetooth proxy closed while scanning'))
            const timer = setTimeout(() => finish(new Error(`the proxy saw no kettle advertisement in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
            let done = false
            const finish = (err, adv) => {
                if (done) return
                done = true
                clearTimeout(timer)
                api.off('message.BluetoothLEAdvertisementResponse', onAdvertisement)
                this.off('apiLost', onLost)
                if (this.api === api && this.ready) {
                    try { api.unsubscribeBluetoothAdvertisementService() } catch (e) { /* closed meanwhile */ }
                }
                if (err) reject(err)
                else resolve(adv)
            }
            api.on('message.BluetoothLEAdvertisementResponse', onAdvertisement)
            this.once('apiLost', onLost)
            try {
                api.subscribeBluetoothAdvertisementService()
            } catch (err) {
                finish(err)
            }
        })
    }

    // Connects and returns the device's characteristics by UUID:
    // { handle, properties: { read, write, notify, ... }, cccd }.
    async connectDevice (address, addressType) {
        this._requireReady()
        if (this.device) throw new Error('already connected to a device')
        const api = this.api
        let response
        try {
            response = await api.connectBluetoothDeviceService(address, addressType, false)
        } catch (err) {
            // Free the proxy's connection slot if it is still trying.
            api.disconnectBluetoothDeviceService(address).catch(() => {})
            throw new Error(`no connection to the kettle through the proxy: ${err.message}`)
        }
        if (!response || Number(response.address) !== address || !response.connected) {
            throw new Error(`the proxy could not connect to the kettle (error ${response ? response.error : 'none'})`)
        }
        this.device = { address, mtu: response.mtu }
        try {
            const { servicesList } = await this._gatt('service discovery', null,
                () => api.listBluetoothGATTServicesService(address))
            return characteristicsByUuid(servicesList)
        } catch (err) {
            await this.disconnectDevice()
            throw err
        }
    }

    async disconnectDevice () {
        const device = this.device
        if (!device) return
        this.device = null
        this._notify.clear()
        if (!this.api || !this.ready) return
        try {
            await this.api.disconnectBluetoothDeviceService(device.address)
        } catch (err) {
            // The proxy releases the slot on its own when the API session ends.
        }
    }

    async read (handle) {
        const response = await this._gatt('read', handle,
            () => this.api.readBluetoothGATTCharacteristicService(this.device.address, handle))
        if (!response || response.handle !== handle) throw new Error(`read on handle ${handle} answered for another handle`)
        return Buffer.from(response.data || '', 'base64')
    }

    async write (handle, data) {
        const response = await this._gatt('write', handle,
            () => this.api.writeBluetoothGATTCharacteristicService(this.device.address, handle, Uint8Array.from(data), true))
        if (!response || response.handle !== handle) throw new Error(`write on handle ${handle} answered for another handle`)
    }

    // Starts notifications. ESPHome's v3 connections leave the client characteristic
    // configuration descriptor to the client, so it is written here (as bleak-esphome does).
    async subscribe (characteristic, onData) {
        if (!characteristic.properties.notify) throw new Error(`handle ${characteristic.handle} does not notify`)
        if (!characteristic.cccd) throw new Error(`handle ${characteristic.handle} has no notification descriptor`)
        const address = this.device && this.device.address
        this._notify.set(characteristic.handle, onData)
        try {
            await this._gatt('notify', characteristic.handle,
                () => this.api.notifyBluetoothGATTCharacteristicService(address, characteristic.handle))
            await this._gatt('descriptor write', characteristic.cccd,
                () => this.api.writeBluetoothGATTDescriptorService(address, characteristic.cccd, NOTIFY_ON))
        } catch (err) {
            this._notify.delete(characteristic.handle)
            throw err
        }
    }

    _gatt (operation, handle, start) {
        const run = () => this._gattNow(operation, handle, start)
        const result = this._queue.then(run, run)
        this._queue = result.catch(() => {})
        return result
    }

    _gattNow (operation, handle, start) {
        if (!this.device || !this.api || !this.ready) {
            return Promise.reject(new Error(`${operation}: not connected to the kettle`))
        }
        const address = this.device.address
        return new Promise((resolve, reject) => {
            let done = false
            const finish = (err, value) => {
                if (done) return
                done = true
                clearTimeout(timer)
                this.off('_gattError', onGattError)
                this.off('_deviceLost', onLost)
                if (err) reject(err)
                else resolve(value)
            }
            const onGattError = (msg) => {
                if (Number(msg.address) === address && (handle === null || msg.handle === handle)) {
                    finish(new GattError(operation, msg.handle, msg.error))
                }
            }
            const onLost = (err) => finish(new Error(`${operation}: ${err.message}`))
            const timer = setTimeout(() => finish(new Error(`${operation}: no answer from the proxy in ${this.timeoutMs} ms`)), this.timeoutMs)
            this.on('_gattError', onGattError)
            this.once('_deviceLost', onLost)
            let pending
            try {
                pending = Promise.resolve(start())
            } catch (err) {
                finish(err)
                return
            }
            pending.then((value) => finish(null, value), (err) => finish(err))
        })
    }
}

function characteristicsByUuid (services) {
    const result = new Map()
    for (const service of services || []) {
        for (const c of service.characteristicsList || []) {
            const cccd = (c.descriptorsList || []).find(d => String(d.uuid).toLowerCase() === CCCD)
            result.set(String(c.uuid).toLowerCase(), {
                uuid: String(c.uuid).toLowerCase(),
                handle: c.handle,
                properties: {
                    read: Boolean(c.properties & PROPERTY.read),
                    write: Boolean(c.properties & PROPERTY.write),
                    writeWithoutResponse: Boolean(c.properties & PROPERTY.writeWithoutResponse),
                    notify: Boolean(c.properties & PROPERTY.notify),
                    indicate: Boolean(c.properties & PROPERTY.indicate),
                },
                cccd: cccd ? cccd.handle : null,
            })
        }
    }
    return result
}

module.exports = EsphomeBleProxy
module.exports.GattError = GattError
module.exports.characteristicsByUuid = characteristicsByUuid
module.exports.PROPERTY = PROPERTY
module.exports.CCCD = CCCD
