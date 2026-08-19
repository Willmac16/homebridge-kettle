'use strict'

const StaggEKGProClient = require('./lib/stagg-ekg-pro-client')
const { startTempPolling } = require('./lib/temperature-polling')

module.exports = (api) => {
    api.registerPlatform('homebridge-kettle-pro', 'StaggKettle', StaggKettlePlatform);
}

class StaggKettlePlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.accessories = new Map();

        api.on('didFinishLaunching', () => this._discoverDevices());
    }

    configureAccessory(accessory) {
        this.accessories.set(accessory.UUID, accessory);
    }

    _discoverDevices() {
        const kettles = this.config.kettles || [];
        if (kettles.length === 0) {
            this.log.warn('No kettles configured — add at least one entry under "kettles" in the platform config.');
        }
        const seen = new Set();

        for (const config of kettles) {
            const uuid = this.api.hap.uuid.generate(config.name);
            seen.add(uuid);

            let accessory = this.accessories.get(uuid);
            if (accessory) {
                accessory.context.config = config;
                this.api.updatePlatformAccessories([accessory]);
            } else {
                accessory = new this.api.platformAccessory(config.name, uuid);
                accessory.context.config = config;
                this.api.registerPlatformAccessories('homebridge-kettle-pro', 'StaggKettle', [accessory]);
                this.accessories.set(uuid, accessory);
            }
            this._setupAccessory(accessory);
        }

        for (const [uuid, accessory] of this.accessories) {
            if (!seen.has(uuid)) {
                this.api.unregisterPlatformAccessories('homebridge-kettle-pro', 'StaggKettle', [accessory]);
                this.accessories.delete(uuid);
            }
        }
    }

    _setupAccessory(accessory) {
        const config = accessory.context.config;
        const mode = String(config.connection || config.mode || '').toLowerCase();
        const { Service, Characteristic } = this.api.hap;
        if (mode === 'wifi') {
            new StaggEKGProWifiHandler(this.log, config, accessory, Service, Characteristic);
        } else {
            new StaggEKGPlusHandler(this.log, config, accessory, Service, Characteristic);
        }
    }
}

class StaggEKGProWifiHandler {
    constructor(log, config, accessory, Service, Characteristic) {
        const client = new StaggEKGProClient(config.url);
        const minTemp = typeof config.minTemp === 'number' ? config.minTemp : 40;
        const maxTemp = typeof config.maxTemp === 'number' ? config.maxTemp : 100;

        accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Fellow')
            .setCharacteristic(Characteristic.Model, 'Stagg EKG Pro')
            .setCharacteristic(Characteristic.SerialNumber, '123-456-789');

        const service = accessory.getService(Service.Thermostat)
            || accessory.addService(Service.Thermostat);

        service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(async () => {
                const body = await client.commandAsync('state');
                const value = client.parseState(body);
                if (value === null) throw new Error(`unrecognised state: ${body.trim()}`);
                return value;
            })
            .onSet(async (value) => {
                await client.commandAsync(`setstate ${client.stateForHomeKit(value)}`);
            });

        service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(async () => {
                const body = await client.commandAsync('state');
                const value = client.parseState(body);
                if (value === null) throw new Error(`unrecognised state: ${body.trim()}`);
                return value;
            });

        service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({ minValue: minTemp, maxValue: maxTemp })
            .onGet(async () => {
                const body = await client.commandAsync('state');
                const targetC = client.parseTargetTemp(body);
                if (targetC === null) throw new Error(`could not parse target temp: ${body.trim()}`);
                return targetC;
            })
            .onSet(async (value) => {
                const targetF = Math.round(client.cToF(value));
                await Promise.all([
                    client.commandAsync(`setsetting settempr ${targetF}`),
                    client.commandAsync(`setstate S_Heat`),
                ]);
            });

        service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: 0, maxValue: maxTemp })
            .onGet(async () => {
                const body = await client.commandAsync('state');
                const tempC = client.parseTemp(body);
                if (tempC === null) throw new Error(`could not parse current temp: ${body.trim()}`);
                return tempC;
            });

        // Periodic polling with configurable intervals for heating vs idle
        startTempPolling(log, config, async (idleTemperatureDue) => {
            const body = await client.commandAsync('state');
            const isHeating = client.parseState(body);
            let temperatureUpdated = false;
            if (isHeating === 1 || idleTemperatureDue) {
                const tempC = client.parseTemp(body);
                if (tempC !== null) {
                    service.updateCharacteristic(Characteristic.CurrentTemperature, tempC);
                    temperatureUpdated = true;
                }
            }
            return { isHeating, temperatureUpdated };
        });

        service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .onGet(async () => 0)
            .onSet(async () => {});
    }
}


class StaggEKGPlusHandler {
    constructor(log, config, accessory, Service, Characteristic) {
        const url = config.url;
        const minTemp = typeof config.minTemp === 'number' ? config.minTemp : 40;
        const maxTemp = typeof config.maxTemp === 'number' ? config.maxTemp : 100;
        const _fetch = (path, opts = {}) =>
            fetch(url + path, { signal: AbortSignal.timeout(5000), ...opts });

        accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Fellow')
            .setCharacteristic(Characteristic.Model, 'Stagg EKG+')
            .setCharacteristic(Characteristic.SerialNumber, '123-456-789');

        const service = accessory.getService(Service.Thermostat)
            || accessory.addService(Service.Thermostat);

        service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
            .setProps({ validValues: [0, 1] })
            .onGet(async () => {
                const body = await _fetch('/state').then(r => r.text());
                return parseFloat(body);
            })
            .onSet(async (value) => {
                await _fetch('/state', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'value=' + value,
                });
            });

        service.getCharacteristic(Characteristic.TargetTemperature)
            .setProps({ minValue: minTemp, maxValue: maxTemp })
            .onGet(async () => {
                const body = await _fetch('/target_temp').then(r => r.text());
                const tempC = (parseFloat(body) - 32) / 1.8;
                if (isNaN(tempC)) throw new Error(`could not parse target temp: ${body}`);
                return tempC;
            })
            .onSet(async (value) => {
                await _fetch('/target_temp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'value=' + value,
                });
            });

        service.getCharacteristic(Characteristic.CurrentTemperature)
            .setProps({ minValue: 0, maxValue: maxTemp })
            .onGet(async () => {
                const body = await _fetch('/current_temp').then(r => r.text());
                const tempC = (parseFloat(body) - 32) / 1.8;
                if (isNaN(tempC)) throw new Error(`could not parse current temp: ${body}`);
                return tempC;
            });

        // Periodic polling with configurable intervals for heating vs idle
        startTempPolling(log, config, async (idleTemperatureDue) => {
            const stateBody = await _fetch('/state').then(r => r.text());
            const isHeating = parseFloat(stateBody);
            let temperatureUpdated = false;
            if (isHeating === 1 || idleTemperatureDue) {
                const currentBody = await _fetch('/current_temp').then(r => r.text());
                const tempC = (parseFloat(currentBody) - 32) / 1.8;
                if (!isNaN(tempC)) {
                    service.updateCharacteristic(Characteristic.CurrentTemperature, tempC);
                    temperatureUpdated = true;
                }
            }
            return { isHeating, temperatureUpdated };
        });

        service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
            .onGet(async () => 0)
            .onSet(async () => {});
    }
}
