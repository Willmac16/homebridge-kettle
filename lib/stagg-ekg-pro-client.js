'use strict'

const request = require('request')

class StaggEKGProClient {
    constructor (url) {
        const baseUrl = (url || "").replace(/\?.*$/, "");
        if (baseUrl.endsWith("/cli")) {
            this.cliUrl = baseUrl;
        } else {
            this.cliUrl = baseUrl.replace(/\/+$/, "") + "/cli";
        }
    }

    _encode (cmd) {
        return String(cmd).replace(/ /g, "+");
    }

    command (cmd, callback) {
        if (!this.cliUrl || this.cliUrl === "/cli") {
            callback(new Error("Missing kettle url; set config.url to the kettle base URL."));
            return;
        }
        const encoded = this._encode(cmd);
        request({
            url: `${this.cliUrl}?cmd=${encoded}`,
            method: "GET"
        }, function (error, response, body) {
            if (error) {
                callback(error);
                return;
            }
            callback(null, body);
        });
    }

    parseState (body) {
        const text = (body || "").trim();
        if (/\bS_(Heat|Hold|StartupToTempr|Calib_(Started|finish))\b/i.test(text)) {
            return 1;
        }
        if (/S_Off/i.test(text)) {
            return 0;
        }
        return null;
    }

    stateForHomeKit (value) {
        return value === 1 ? "S_Heat" : "S_Off";
    }

    parseTemp (body) {
        const labeled = this._parseTempLine(body, "tempr");
        return labeled !== null ? labeled : this._parseFirstNumber(body);
    }

    parseTargetTemp (body) {
        const target = this._parseTempLine(body, "temprT");
        if (target !== null) return target;
        const fallback = this._parseTempLine(body, "temps");
        if (fallback !== null) return fallback;
        return this.parseTemp(body);
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
