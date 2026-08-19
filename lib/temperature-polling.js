'use strict'

function positiveInterval(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function getPollIntervals(config) {
    return {
        heating: positiveInterval(config.pollIntervalHeating, 10000),
        idle: positiveInterval(config.pollIntervalIdle, 1800000),
    };
}

function startTempPolling(log, config, updateTempFn, options = {}) {
    const { heating, idle } = getPollIntervals(config);
    const schedule = options.setTimeout || setTimeout;
    const now = options.now || Date.now;
    let lastIdleTemperatureUpdate = null;

    function poll() {
        const idleTemperatureDue = lastIdleTemperatureUpdate === null
            || now() - lastIdleTemperatureUpdate >= idle;

        Promise.resolve(updateTempFn(idleTemperatureDue)).then(({ isHeating, temperatureUpdated }) => {
            if (isHeating !== 1 && idleTemperatureDue && temperatureUpdated) {
                lastIdleTemperatureUpdate = now();
            }

            // Check state at the heating cadence so a kettle which starts while
            // idle switches to frequent temperature updates without waiting for
            // the (potentially much longer) idle temperature interval.
            schedule(poll, heating);
        }).catch((err) => {
            log.debug('Temperature poll failed:', err.message);
            schedule(poll, heating);
        });
    }

    poll();
}

module.exports = { getPollIntervals, startTempPolling }
