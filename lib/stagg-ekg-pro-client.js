'use strict'

class StaggEKGProClient {
    constructor (url) {
        const baseUrl = (url || "").replace(/\?.*$/, "");
        if (baseUrl.endsWith("/cli")) {
            this.cliUrl = baseUrl;
        } else {
            this.cliUrl = baseUrl.replace(/\/+$/, "") + "/cli";
        }
        this._inflight = new Map();
    }

    _encode (cmd) {
        return String(cmd).split(" ").map(encodeURIComponent).join("+");
    }

    commandAsync (cmd) {
        if (!this.cliUrl || this.cliUrl === "/cli") {
            return Promise.reject(new Error("Missing kettle url; set config.url to the kettle base URL."));
        }
        if (this._inflight.has(cmd)) return this._inflight.get(cmd);
        const encoded = this._encode(cmd);
        const promise = fetch(`${this.cliUrl}?cmd=${encoded}`, { signal: AbortSignal.timeout(5000) })
            .then(res => res.text())
            .finally(() => this._inflight.delete(cmd));
        this._inflight.set(cmd, promise);
        return promise;
    }

    command (cmd, callback) {
        this.commandAsync(cmd).then(body => callback(null, body)).catch(err => callback(err));
    }

    parseState (body) {
        const text = (body || "").trim();
        if (/\bS_(Heat|Hold|StartupToTempr|Calib_(Started|finish))\b/i.test(text)) {
            return 1;
        }
        if (/\bS_Off\b/i.test(text)) {
            return 0;
        }
        return null;
    }

    stateForHomeKit (value) {
        return value === 1 ? "S_Heat" : "S_Off";
    }

    parseTemp (body) {
        const labeled = this._parseTempLine(body, "tempr");
        // A structured state response can explicitly report `tempr=nan` when
        // no sensor reading is available. In that case, do not fall back to a
        // timestamp or another unrelated number elsewhere in the response.
        const hasTempField = /\btempr\s*=/i.test(body || "");
        const value = labeled !== null
            ? labeled
            : (hasTempField ? null : this._parseFirstNumber(body));

        // The firmware reports a large sentinel-like value when the kettle is
        // lifted from its base. Do not pass impossible readings to HomeKit,
        // whose CurrentTemperature characteristic only accepts up to 100 C.
        return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
    }

    parseTargetTemp (body) {
        const target = this._parseTempLine(body, "temprT");
        if (target !== null) return target;
        return this._parseTempLine(body, "temps");
    }

    fToC (f) {
        return (f - 32) / 1.8;
    }

    cToF (c) {
        return (c * 1.8) + 32;
    }

    _parseTempLine (body, label) {
        const re = new RegExp(`\\b${label}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*([CF])?`, "i");
        const match = (body || "").match(re);
        if (!match) return null;
        const value = parseFloat(match[1]);
        const unit = (match[2] || "C").toUpperCase();
        return unit === "F" ? this.fToC(value) : value;
    }

    _parseFirstNumber (body) {
        const match = (body || "").match(/-?\d+(?:\.\d+)?/);
        return match ? parseFloat(match[0]) : null;
    }
}

module.exports = StaggEKGProClient
