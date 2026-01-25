# Homebridge Kettle
This is a simple Homebridge plugin for Fellow Stagg kettles so they can be controlled over HomeKit.

It supports Stagg EKG+ and Stagg EKG Pro via a BLE bridge HTTP API, plus Stagg EKG Pro over Wi-Fi (HTTP CLI API).

Note: heating control uses the CLI `setstate` command, so your kettle firmware must support `setstate 0/1`.

## Config Example
```json
"accessories": [
    {
        "accessory": "MyKettle",
        "connection": "wifi",
        "name": "Kettle",
        "url": "http://192.168.1.32",
        "minTemp": 40,
        "maxTemp": 100
    }
],
```

## Accessory Types
This plugin supports two accessory types:
- `MyKettle` — Stagg EKG+ or Stagg EKG Pro over BLE bridge (legacy API: /state, /current_temp, /target_temp)
- `MyKettleProWifi` — Stagg EKG Pro over Wi-Fi CLI (this fork)

### Stagg EKG Pro (Wi-Fi CLI)
```json
"accessories": [
    {
        "accessory": "MyKettle",
        "connection": "wifi",
        "name": "Kettle",
        "url": "http://192.168.1.32",
        "minTemp": 40,
        "maxTemp": 100
    }
]
```

### Stagg EKG+ / EKG Pro (BLE Bridge)
```json
"accessories": [
    {
        "accessory": "MyKettle",
        "connection": "ble",
        "name": "Kettle",
        "url": "http://192.168.1.32",
        "minTemp": 40,
        "maxTemp": 100
    }
]
```

## Homebridge UI
If you use the Homebridge Config UI, this plugin now includes a config schema so you get the graphical form. Choose the appropriate accessory type in the UI for your kettle model.


`minTemp` and `maxTemp` are specified in Celsius.
