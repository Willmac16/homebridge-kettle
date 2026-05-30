'use strict'

const request = require('request')
const url = require('url')
const StaggEKGProClient = require('./lib/stagg-ekg-pro-client')

let Service, Characteristic

module.exports = (homebridge) => {
    Service = homebridge.hap.Service
    Characteristic = homebridge.hap.Characteristic
    homebridge.registerAccessory("homebridge-kettle", "MyKettle", StaggEKGUnifiedAccessory)
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
                unit: 1
            })

        this.service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({
                maxValue: this.maxTemp,
                // Allow room-temp readings below the target range.
                minValue: 0,
                unit: 1
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
            if (error) {
                callback(error);
                return;
            }
            const value = this.client.parseState(body);
            this.log(`getTargetHeatingCoolingState result:`, body)
            if (value !== null) {
                this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, value)
            }
            callback(null, this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).value)
        })
    }

    setTargetHeatingCoolingStateCharacteristicHandler (value, callback) {
        this.log(`calling setTargetHeatingCoolingStateCharacteristicHandler`, value)
        const state = this.client.stateForHomeKit(value);
        this.client.command(`setstate ${state}`, (error) => {
            if (error) {
                callback(error);
                return;
            }
            this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, value)
            callback(null, value)
        })
    }

    getTargetTemperatureHandler (callback) {
        this.log(`calling getTargetTemperatureHandler`)
        this.client.command("state", (error, body) => {
            if (error) {
                callback(error);
                return;
            }
            const targetC = this.client.parseTargetTemp(body);
            this.log(`getTargetTemperatureHandler result:`, body)
            if (targetC !== null) {
                this.service.updateCharacteristic(Characteristic.TargetTemperature, targetC)
            }
            callback(null, this.service.getCharacteristic(Characteristic.TargetTemperature).value)
        })
    }

    setTargetTemperatureHandler (value, callback) {
        this.log(`calling setTargetTemperatureHandler`, value)
        const targetF = Math.round(this.client.cToF(value));
        this.client.command(`setsetting settempr ${targetF}`, (error) => {
            if (error) {
                callback(error);
                return;
            }
            // Kick out of Hold so UI reflects heating state
            this.client.command(`setstate S_Heat`, (stateError) => {
                if (stateError) {
                    callback(stateError);
                    return;
                }
                this.service.updateCharacteristic(Characteristic.TargetTemperature, value)
                callback(null, value)
            })
        })
    }

    getCurrentTemperatureHandler (callback) {
        this.log(`calling getCurrentTemperatureHandler`)
        this.client.command("state", (error, body) => {
            if (error) {
                callback(error);
                return;
            }
            const tempC = this.client.parseTemp(body);
            this.log(`getCurrentTemperatureHandler result:`, body)
            if (tempC !== null) {
                this.service.updateCharacteristic(Characteristic.CurrentTemperature, tempC)
            }
            callback(null, this.service.getCharacteristic(Characteristic.CurrentTemperature).value)
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


class StaggEKGUnifiedAccessory {
    constructor (log, config) {
        const mode = String((config && (config.connection || config.mode)) || '').toLowerCase();
        const isWifi = (config && config.accessory === 'MyKettleProWifi') || mode === 'wifi' || mode === 'cli';
        if (isWifi) {
            return new StaggEKGProWifiAccessory(log, config);
        }
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
                unit: 1
            })

        this.service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({
                maxValue: this.maxTemp,
                minValue: 0,
                unit: 1
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
        var self = this;
        request({
            url: self.url + "/state",
            method: "GET"
        }, function (error, response, body) {
            if (error) {
                callback(error);
                return;
            }
            self.log(`getTargetHeatingCoolingState result:`, body)
            self.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, body)
            callback(null, self.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).value)
        });
    }

    setTargetHeatingCoolingStateCharacteristicHandler (value, callback) {
        this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, value)
        this.log(`calling setTargetHeatingCoolingStateCharacteristicHandler`, value)
        var self = this;
        request({
            url: self.url + "/state",
            method: "POST",
            json: false,
            body: "value=" + value,
            headers: {"Content-Length": 7}
        }, function (error, response, body){
            if (error) {
                callback(error);
                return;
            }
            callback(null, value)
        });
    }

    getTargetTemperatureHandler (callback) {
        this.log(`calling getTargetTemperatureHandler`)
        var self = this;
        request({
            url: self.url + "/target_temp",
            method: "GET"
        }, function (error, response, body) {
            if (error) {
                callback(error);
                return;
            }
            self.log(`getTargetTemperatureHandler result:`, body)
            self.service.updateCharacteristic(Characteristic.TargetTemperature, (body - 32)/1.8000)
            callback(null, self.service.getCharacteristic(Characteristic.TargetTemperature).value)
        });
    }

    setTargetTemperatureHandler (value, callback) {
        this.service.updateCharacteristic(Characteristic.TargetTemperature, value)
        this.log(`calling setTargetTemperatureHandler`, value)
        var self = this;
        request({
            url: self.url + "/target_temp",
            method: "POST",
            json: false,
            body: "value=" + value.toString(),
            headers: {"Content-Length": 6 + value.toString().length}
        }, function (error, response, body){
            if (error) {
                callback(error);
                return;
            }
            callback(null, value)
        });
    }

    getCurrentTemperatureHandler (callback) {
        this.log(`calling getCurrentTemperatureHandler`)
        var self = this;
        request({
            url: self.url + "/current_temp",
            method: "GET"
        }, function (error, response, body) {
            if (error) {
                callback(error);
                return;
            }
            self.log(`getCurrentTemperatureHandler result:`, body)
            self.service.updateCharacteristic(Characteristic.CurrentTemperature, (body - 32)/1.8000)
            callback(null, self.service.getCharacteristic(Characteristic.CurrentTemperature).value)
        });
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

module.exports.StaggEKGUnifiedAccessory = StaggEKGUnifiedAccessory
