'use strict'

const StaggEKGProClient = require('./lib/stagg-ekg-pro-client')

let Service, Characteristic

module.exports = (homebridge) => {
    Service = homebridge.hap.Service
    Characteristic = homebridge.hap.Characteristic
    homebridge.registerAccessory("homebridge-kettle-pro", "MyKettle", StaggEKGAccessoryFactory)
}

class StaggEKGProWifiAccessory {
    constructor (log, config) {
        this.log = log;
        this.config = config;
        this.service = new Service.Thermostat(this.config.name);
        this.tempDisplayUnits = 0;

        this.minTemp = (typeof this.config.minTemp === "number") ? this.config.minTemp : 40;
        this.maxTemp = (typeof this.config.maxTemp === "number") ? this.config.maxTemp : 100;

        this.client = new StaggEKGProClient(this.config.url);
    }

    getServices () {
        const informationService = new Service.AccessoryInformation()
        informationService
            .setCharacteristic(Characteristic.Manufacturer, "Fellow")
            .setCharacteristic(Characteristic.Model, "Stagg EKG Pro")
            .setCharacteristic(Characteristic.SerialNumber, "123-456-789")

        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .on('get', this.getTargetHeatingCoolingStateCharacteristicHandler.bind(this))
            .on('set', this.setTargetHeatingCoolingStateCharacteristicHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TargetTemperature)
            .on('get', this.getTargetTemperatureHandler.bind(this))
            .on('set', this.setTargetTemperatureHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({
                maxValue: this.maxTemp,
                minValue: this.minTemp,
            })

        this.service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({
                maxValue: this.maxTemp,
                // Allow room-temp readings below the target range.
                minValue: 0,
            })

        this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .setProps({value: this.tempDisplayUnits})

        this.service.getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', this.getCurrentTemperatureHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .on('get', this.getTemperatureDisplayUnitsHandler.bind(this))
            .on('set', this.setTemperatureDisplayUnitsHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({validValues: [0, 1]})

        this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .setProps({validValues: [0, 1]})

        return [informationService, this.service]
    }

    getTargetHeatingCoolingStateCharacteristicHandler (callback) {
        this.log(`calling getTargetHeatingCoolingStateCharacteristicHandler`)
        this.client.command("state", (error, body) => {
            if (error) { callback(error); return; }
            const value = this.client.parseState(body);
            this.log(`getTargetHeatingCoolingState result:`, body)
            if (value === null) { callback(new Error(`unrecognised state: ${body.trim()}`)); return; }
            callback(null, value);
        })
    }

    setTargetHeatingCoolingStateCharacteristicHandler (value, callback) {
        this.log(`calling setTargetHeatingCoolingStateCharacteristicHandler`, value)
        const state = this.client.stateForHomeKit(value);
        this.client.command(`setstate ${state}`, (error) => {
            if (error) { callback(error); return; }
            callback(null, value);
        })
    }

    getTargetTemperatureHandler (callback) {
        this.log(`calling getTargetTemperatureHandler`)
        this.client.command("state", (error, body) => {
            if (error) { callback(error); return; }
            const targetC = this.client.parseTargetTemp(body);
            this.log(`getTargetTemperatureHandler result:`, body)
            if (targetC === null) { callback(new Error(`could not parse target temp: ${body.trim()}`)); return; }
            callback(null, targetC);
        })
    }

    setTargetTemperatureHandler (value, callback) {
        this.log(`calling setTargetTemperatureHandler`, value)
        const targetF = Math.round(this.client.cToF(value));
        Promise.all([
            this.client.commandAsync(`setsetting settempr ${targetF}`),
            this.client.commandAsync(`setstate S_Heat`),
        ])
            .then(() => callback(null, value))
            .catch(err => callback(err));
    }

    getCurrentTemperatureHandler (callback) {
        this.log(`calling getCurrentTemperatureHandler`)
        this.client.command("state", (error, body) => {
            if (error) { callback(error); return; }
            const tempC = this.client.parseTemp(body);
            this.log(`getCurrentTemperatureHandler result:`, body)
            if (tempC === null) { callback(new Error(`could not parse current temp: ${body.trim()}`)); return; }
            callback(null, tempC);
        })
    }

    getTemperatureDisplayUnitsHandler (callback) {
        this.log(`calling getTemperatureDisplayUnitsHandler`, this.tempDisplayUnits)
        callback(null, this.tempDisplayUnits)
    }

    setTemperatureDisplayUnitsHandler (value, callback) {
        this.log(`calling setTemperatureDisplayUnitsHandler`, value)
        callback(null, this.tempDisplayUnits)
    }
}


function StaggEKGAccessoryFactory(log, config) {
    const mode = String((config && (config.connection || config.mode)) || '').toLowerCase();
    if (mode === 'wifi') {
        return new StaggEKGProWifiAccessory(log, config);
    } else {
        return new StaggEKGPlusAccessory(log, config);
    }
}


class StaggEKGPlusAccessory {
    constructor (log, config) {
        this.log = log;
        this.config = config;
        this.service = new Service.Thermostat(this.config.name);
        this.url = this.config.url;
        this.tempDisplayUnits = 0;
        this._fetch = (url, opts = {}) => fetch(url, { signal: AbortSignal.timeout(5000), ...opts });

        this.minTemp = (typeof this.config.minTemp === "number") ? this.config.minTemp : 40;
        this.maxTemp = (typeof this.config.maxTemp === "number") ? this.config.maxTemp : 100;
    }

    getServices () {
        const informationService = new Service.AccessoryInformation()
        informationService
            .setCharacteristic(Characteristic.Manufacturer, "Fellow")
            .setCharacteristic(Characteristic.Model, "Stagg EKG+")
            .setCharacteristic(Characteristic.SerialNumber, "123-456-789")

        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .on('get', this.getTargetHeatingCoolingStateCharacteristicHandler.bind(this))
            .on('set', this.setTargetHeatingCoolingStateCharacteristicHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TargetTemperature)
            .on('get', this.getTargetTemperatureHandler.bind(this))
            .on('set', this.setTargetTemperatureHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({
                maxValue: this.maxTemp,
                minValue: this.minTemp,
            })

        this.service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({
                maxValue: this.maxTemp,
                minValue: 0,
            })

        this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .setProps({value: this.tempDisplayUnits})

        this.service.getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', this.getCurrentTemperatureHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .on('get', this.getTemperatureDisplayUnitsHandler.bind(this))
            .on('set', this.setTemperatureDisplayUnitsHandler.bind(this))

        this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({validValues: [0, 1]})

        this.service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .setProps({validValues: [0, 1]})

        return [informationService, this.service]
    }

    getTargetHeatingCoolingStateCharacteristicHandler (callback) {
        this.log(`calling getTargetHeatingCoolingStateCharacteristicHandler`)
        this._fetch(this.url + "/state")
            .then(res => res.text())
            .then(body => {
                this.log(`getTargetHeatingCoolingState result:`, body)
                callback(null, parseFloat(body));
            })
            .catch(err => callback(err));
    }

    setTargetHeatingCoolingStateCharacteristicHandler (value, callback) {
        this.log(`calling setTargetHeatingCoolingStateCharacteristicHandler`, value)
        this._fetch(this.url + "/state", {
            method: "POST",
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            body: "value=" + value
        })
            .then(() => callback(null, value))
            .catch(err => callback(err));
    }

    getTargetTemperatureHandler (callback) {
        this.log(`calling getTargetTemperatureHandler`)
        this._fetch(this.url + "/target_temp")
            .then(res => res.text())
            .then(body => {
                this.log(`getTargetTemperatureHandler result:`, body)
                const tempC = (parseFloat(body) - 32) / 1.8;
                if (isNaN(tempC)) { callback(new Error(`could not parse target temp: ${body}`)); return; }
                callback(null, tempC);
            })
            .catch(err => callback(err));
    }

    setTargetTemperatureHandler (value, callback) {
        this.log(`calling setTargetTemperatureHandler`, value)
        this._fetch(this.url + "/target_temp", {
            method: "POST",
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            body: "value=" + value
        })
            .then(() => callback(null, value))
            .catch(err => callback(err));
    }

    getCurrentTemperatureHandler (callback) {
        this.log(`calling getCurrentTemperatureHandler`)
        this._fetch(this.url + "/current_temp")
            .then(res => res.text())
            .then(body => {
                this.log(`getCurrentTemperatureHandler result:`, body)
                const tempC = (parseFloat(body) - 32) / 1.8;
                if (isNaN(tempC)) { callback(new Error(`could not parse current temp: ${body}`)); return; }
                callback(null, tempC);
            })
            .catch(err => callback(err));
    }

    getTemperatureDisplayUnitsHandler (callback) {
        this.log(`calling getTemperatureDisplayUnitsHandler`, this.tempDisplayUnits)
        callback(null, this.tempDisplayUnits)
    }

    setTemperatureDisplayUnitsHandler (value, callback) {
        this.log(`calling setTemperatureDisplayUnitsHandler`, value)
        callback(null, this.tempDisplayUnits)
    }
}

module.exports.StaggEKGAccessoryFactory = StaggEKGAccessoryFactory
