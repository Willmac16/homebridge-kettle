'use strict'

function createTemperatureRecovery(log, checkTemperature, options = {}) {
    const delay = options.delay || 10000;
    const schedule = options.setTimeout || setTimeout;
    const cancel = options.clearTimeout || clearTimeout;
    let active = false;
    let timer = null;

    function queue() {
        if (!active || timer !== null) return;
        timer = schedule(poll, delay);
        timer.unref?.();
    }

    async function poll() {
        timer = null;
        try {
            if (await checkTemperature()) {
                active = false;
                return;
            }
        } catch (err) {
            log.debug('Temperature recovery failed:', err.message);
        }
        queue();
    }

    function start() {
        if (active) return;
        active = true;
        queue();
    }

    function stop() {
        active = false;
        if (timer !== null) {
            cancel(timer);
            timer = null;
        }
    }

    return { start, stop };
}

module.exports = { createTemperatureRecovery }
