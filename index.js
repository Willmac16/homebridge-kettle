'use strict'

const request = require('request')
const url = require('url')

let Service, Characteristic

module.exports = (homebridge) => {
    Service = homebridge.hap.Service
    Characteristic = homebridge.hap.Characteristic
    homebridge.registerAccessory("homebridge-kettle", "MyKettle", StaggEKGUnifiedAccessory)
    homebridge.registerAccessory("homebridge-kettle", "MyKettleProWifi", StaggEKGProWifiAccessory)
}

class StaggEKGProWifiAccessory {
    constructor (log, config) {
        this.log = log;
        this.config = config;
        this.service = new Service.Thermostat(this.config.name);
        this.url = this.config.url;
        this.tempDisplayUnits = 0;

        this.minTemp = (typeof this.config.minTemp === "number") ? this.config.minTemp : 40;
        this.maxTemp = (typeof this.config.maxTemp === "number") ? this.config.maxTemp : 100;

        const baseUrl = (this.url || "").replace(/\?.*$/, "");
        if (baseUrl.endsWith("/cli")) {
            this.cliUrl = baseUrl;
        } else {
            this.cliUrl = baseUrl.replace(/\/+$/, "") + "/cli";
        }
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
        this._cliCommand("state", (error, body) => {
            if (error) {
                callback(error);
                return;
            }
            const value = this._parseState(body);
            this.log(`getTargetHeatingCoolingState result:`, body)
            if (value !== null) {
                this.service.updateCharacteristic(Characteristic.TargetHeatingCoolingState, value)
            }
            callback(null, this.service.getCharacteristic(Characteristic.TargetHeatingCoolingState).value)
        })
    }

    setTargetHeatingCoolingStateCharacteristicHandler (value, callback) {
        this.log(`calling setTargetHeatingCoolingStateCharacteristicHandler`, value)
        const state = this._stateForHomeKit(value);
        this._cliCommand(`setstate ${state}`, (error) => {
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
        this._cliCommand("state", (error, body) => {
            if (error) {
                callback(error);
                return;
            }
            const targetC = this._parseTargetTemp(body);
            this.log(`getTargetTemperatureHandler result:`, body)
            if (targetC !== null) {
                this.service.updateCharacteristic(Characteristic.TargetTemperature, targetC)
            }
            callback(null, this.service.getCharacteristic(Characteristic.TargetTemperature).value)
        })
    }

    setTargetTemperatureHandler (value, callback) {
        this.log(`calling setTargetTemperatureHandler`, value)
        const targetF = Math.round(this._cToF(value));
        this._cliCommand(`setsetting settempr ${targetF}`, (error) => {
            if (error) {
                callback(error);
                return;
            }
            // Kick out of Hold so UI reflects heating state
            this._cliCommand(`setstate S_Heat`, (stateError) => {
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
        this._cliCommand("state", (error, body) => {
            if (error) {
                callback(error);
                return;
            }
            const tempC = this._parseTemp(body);
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

    _cliCommand (cmd, callback) {
        if (!this.cliUrl || this.cliUrl === "/cli") {
            callback(new Error("Missing kettle url; set config.url to the kettle base URL."));
            return;
        }
        const encodedCmd = this._encodeCliCommand(cmd);
        request({
            url: `${this.cliUrl}?cmd=${encodedCmd}`,
            method: "GET"
        }, function (error, response, body) {
            if (error) {
                callback(error);
                return;
            }
            callback(null, body)
        });
    }

    _encodeCliCommand (cmd) {
        // Match kettle.sh behavior: replace spaces with '+' only.
        return String(cmd).replace(/ /g, "+");
    }

    _parseFirstNumber (body) {
        const match = (body || "").match(/-?\d+(?:\.\d+)?/);
        return match ? parseFloat(match[0]) : null;
    }

    _parseState (body) {
        const text = (body || "").trim();
        if (/\bS_(Heat|Hold|StartupToTempr|Calib_(Started|finish))\b/i.test(text)) {
            return 1;
        }
        if (/S_Off/i.test(text)) {
            return 0;
        }
        return null;
    }

    _stateForHomeKit (value) {
        return value === 1 ? "S_Heat" : "S_Off";
    }

    _parseSetting (body, name) {
        const re = new RegExp(`${name}\\s*[:=]\\s*(-?\\d+(?:\\.\\d+)?)`, "i");
        const match = (body || "").match(re);
        if (match) {
            return parseFloat(match[1]);
        }
        return this._parseFirstNumber(body);
    }

    _parseTemp (body) {
        const labeled = this._parseTempLine(body, "tempr");
        if (labeled !== null) {
            return labeled;
        }
        return this._parseFirstNumber(body);
    }

    _parseTargetTemp (body) {
        const target = this._parseTempLine(body, "temprT");
        if (target !== null) {
            return target;
        }
        const fallback = this._parseTempLine(body, "temps");
        if (fallback !== null) {
            return fallback;
        }
        return this._parseTemp(body);
    }

    _parseTempLine (body, label) {
        const re = new RegExp(`\\b${label}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*([CF])?`, "i");
        const match = (body || "").match(re);
        if (!match) {
            return null;
        }
        const value = parseFloat(match[1]);
        const unit = (match[2] || "C").toUpperCase();
        if (unit === "F") {
            return this._fToC(value);
        }
        return value;
    }

    _fToC (f) {
        return (f - 32) / 1.8;
    }

    _cToF (c) {
        return (c * 1.8) + 32;
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
module.exports.StaggEKGPlusAccessory = StaggEKGPlusAccessory
module.exports.StaggEKGProWifiAccessory = StaggEKGProWifiAccessory
module.exports.StaggEKGAccessory = StaggEKGProWifiAccessory
