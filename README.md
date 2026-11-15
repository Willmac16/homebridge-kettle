# homebridge-kettle-pro

Homebridge plugin for Fellow Stagg kettles. Supports:
- **Stagg EKG Pro** on firmware 1.2.26 over Wi-Fi (native HTTP API), with on/off over Bluetooth LE through an ESPHome Bluetooth proxy
- **Stagg EKG Pro** on firmware 1.1.x over Wi-Fi (HTTP CLI API)
- **Stagg EKG+ / EKG Pro** over BLE bridge HTTP API (legacy)

Fork of [calvinmclean/homebridge-kettle](https://github.com/calvinmclean/homebridge-kettle).

## Install

```
npm install -g homebridge-kettle-pro
```

## Config

```json
"platforms": [
    {
        "platform": "StaggKettle",
        "name": "Kettles",
        "kettles": [
            {
                "name": "Kettle",
                "connection": "native",
                "url": "http://192.168.1.32",
                "bluetooth": {
                    "proxy": "kettle-proxy.local"
                },
                "minTemp": 40,
                "maxTemp": 100
            }
        ]
    }
]
```

Each entry in `kettles` becomes one accessory in HomeKit.

| Field | Required | Description |
|---|---|---|
| `name` | yes | Name shown in HomeKit |
| `connection` | yes | `"native"` for EKG Pro firmware 1.2.26, `"wifi"` for EKG Pro firmware 1.1.x (CLI), `"ble"` for BLE bridge |
| `url` | yes | Base URL of the kettle (Wi-Fi) or bridge (BLE). No trailing slash. |
| `minTemp` | no | Minimum target temp in °C (default: 40) |
| `maxTemp` | no | Maximum target temp in °C (default: 100) |
| `pollInterval` | no | `native` only: seconds between background reads (default: 15, minimum: 5) |
| `bluetooth.proxy` | no | `native` only: host of an ESPHome Bluetooth proxy near the kettle; turns on on/off (see below) |
| `bluetooth.port` | no | the proxy's native API port (default: 6053) |
| `bluetooth.encryptionKey` | no | the proxy's `api: encryption: key:`, if it has one |
| `bluetooth.address` | no | the kettle's Bluetooth address; without it the first kettle the proxy sees (`EKG-…`) is used and its address logged |

## Connection types

Which firmware is the kettle running? `http://<kettle>/` shows `Current version`.

### Wi-Fi native API (`connection: "native"`)
For firmware 1.2.26, which mutes the CLI: `/cli` answers with its input form only, so the `wifi` connection gets nothing to read and HomeKit reads time out. This connection reads the kettle's `/temp` JSON every `pollInterval` seconds and answers HomeKit from the last reading, and sets the target temperature through the settings record at `/api` (read back to confirm).

Limits of firmware 1.2.26 over Wi-Fi:
- **No on/off.** The firmware has no Wi-Fi power command, so without `bluetooth` switching the kettle on or off from HomeKit is refused; add `bluetooth` (below), or use the kettle itself or the Fellow app.
- **Wi-Fi pauses while heating or holding.** HomeKit keeps the last known state until the kettle answers again (one warning in the log when it stops answering, one info line when it's back). With `bluetooth`, readings keep coming over Bluetooth.

#### On/off over Bluetooth (`bluetooth`)
Firmware 1.2.26 switches on and off over Bluetooth LE only. Homebridge rarely has a Bluetooth adapter near the kettle (and a container with its own network can't use the host's), so the plugin reaches the kettle the way Home Assistant does: through an [ESPHome Bluetooth proxy](https://esphome.io/components/bluetooth_proxy/), any ESP32 within a few metres of the kettle, on the network. ESPHome's sample configurations there (Wi-Fi or Ethernet) work as they are; the parts that matter here:

```yaml
api:                  # optionally with encryption: key: ... (then set bluetooth.encryptionKey)
esp32_ble_tracker:
bluetooth_proxy:
  active: true        # GATT connections, not just advertisements
```

Homebridge needs to reach the proxy on tcp/6053. The plugin keeps one Bluetooth connection open (one of the proxy's connection slots), asks the kettle for a status every 500 ms, and then:

- **On/off** from HomeKit is one press of the kettle's dial, sent only after a status received after the request shows the kettle in the opposite state: on only from standby (`S_OFF`) and only on its base, off only while heating or holding. Switching off can take a second press (the first may only leave the brew-time screen); that is sent once, after three newer status frames that still show heating. Nothing is retried or sent over Wi-Fi instead, and a press the kettle doesn't confirm within 15 s is logged as unconfirmed.
- **Readings** (temperature, target, heating) come over Bluetooth, also while heating; `/temp` is only polled when the Bluetooth link is down.
- **Target temperature** is written over Bluetooth while the link is up (read back to confirm), else over Wi-Fi.
- Writes are sent only to firmware 1.2.26, the version they were validated on; on other firmware the link gives readings only.

Close the Fellow app if on/off stops working: the kettle takes one Bluetooth connection at a time.

Firmware 1.2.24 has neither a working CLI nor this API. Wire formats (HTTP and Bluetooth) and the Bluetooth power rules follow [bramboe/stagg-ekg-plus-ha](https://github.com/bramboe/stagg-ekg-plus-ha).

### Wi-Fi CLI (`connection: "wifi"`)
Talks directly to the EKG Pro's built-in HTTP CLI (`/cli?cmd=...`). Requires firmware that supports `setstate` and `setsetting settempr` (1.1.x; 1.2.24 and later mute the CLI's output).

### BLE bridge (`connection: "ble"`)
Talks to the legacy [stagg-ekg-plus](https://github.com/calvinmclean/stagg-ekg-plus) Python bridge via `/state`, `/current_temp`, `/target_temp`.

## Homebridge UI

A config schema is included — use the graphical form in Homebridge Config UI X to configure the plugin.
