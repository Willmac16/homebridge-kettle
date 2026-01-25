# Homebridge Kettle
This is a simple Homebridge plugin for the Fellow Stagg EKG Pro/Plus so that it can be controlled over WiFi using HomeKit.

This version talks directly to the kettle's HTTP CLI API (no Python/BLE bridge required).

Note: heating control uses the CLI `setstate` command, so your kettle firmware must support `setstate 0/1`.

## Config Example
```json
"accessories": [
    {
        "accessory": "MyKettle",
        "room": "Kitchen",
        "name": "Kettle",
        "url": "http://192.168.1.32",
        "minTemp": 40,
        "maxTemp": 100
    }
],
```

`minTemp` and `maxTemp` are specified in Celsius.
