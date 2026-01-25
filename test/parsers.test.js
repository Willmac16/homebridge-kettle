'use strict'

const assert = require('assert')
const { StaggEKGAccessory } = require('../index')
const { test, banner } = require('./_harness')

function makeInstance() {
  return Object.create(StaggEKGAccessory.prototype)
}

const STATE_OUTPUT = `
            <form action="cli" method="GET">
            <label for="x">CLI Command:</label><br>
            <input type="text" id="cli" name="cmd"><br>
            </form>         
            I (991010) Cli: cmd len 5: 'state'
I (991010) Main: OTA vd 1 ldt 121 ldr 7 dip 0 waitsec 85411 numf 1 wgi 1 iot r 0
scrname=wnd
value=50662426
mode=S_Off
tempr=50.491463 C
temprB=99.459999 C
temprT=96.111115 C
ketl= ho 0 wd 0 nw 0 ipb 0 bf 0 tr 0
temps=205 F
tempsc=192 2C
units=1
clock=12:26
ticks=991020 0 989274
ble conn=0
I (991040) Cli: command 'state' ret 0
`

const STATE_OUTPUT_HEAT = `
            <form action="cli" method="GET">
            <label for="x">CLI Command:</label><br>
            <input type="text" id="cli" name="cmd"><br>
            </form>         
            I (1640440) Cli: cmd len 5: 'state'
I (1640440) Main: OTA vd 1 ldt 121 ldr 7 dip 0 waitsec 0 numf 1 wgi 1 iot r 0
scrname=wnd
value=167
mode=S_Heat
tempr=88.157149 C
temprB=99.459999 C
temprT=83.888885 C
ketl= ho 0 wd 0 nw 0 ipb 0 bf 0 tr 0
temps=183 F
tempsc=192 2C
units=1
clock=12:37
ticks=1640440 0 1638694
ble conn=0
I (1640460) Cli: command 'state' ret 0
`

const STATE_OUTPUT_HOLD = `
            <form action="cli" method="GET">
            <label for="x">CLI Command:</label><br>
            <input type="text" id="cli" name="cmd"><br>
            </form>         
            I (1674720) Cli: cmd len 5: 'state'
I (1674720) Main: OTA vd 1 ldt 121 ldr 7 dip 0 waitsec 0 numf 1 wgi 1 iot r 0
scrname=wnd
value=167
mode=S_Hold
tempr=87.158235 C
temprB=99.459999 C
temprT=83.888885 C
ketl= ho 0 wd 0 nw 0 ipb 0 bf 0 tr 0
temps=183 F
tempsc=192 2C
units=1
clock=12:37
ticks=1674720 0 1672975
ble conn=0
I (1674740) Cli: command 'state' ret 0
`

const STATE_OUTPUT_HOLD_MENU = `
            <form action="cli" method="GET">
            <label for="x">CLI Command:</label><br>
            <input type="text" id="cli" name="cmd"><br>
            </form>         
            I (1718160) Cli: cmd len 5: 'state'
I (1718160) Main: OTA vd 1 ldt 121 ldr 7 dip 0 waitsec 0 numf 1 wgi 1 iot r 0
scrname=menu - schedule.png
value=2
mode=S_Hold+menu
tempr=85.851106 C
temprB=99.459999 C
temprT=83.888885 C
ketl= ho 0 wd 0 nw 0 ipb 0 bf 0 tr 0
temps=183 F
tempsc=192 2C
units=1
clock=12:38
ticks=1718160 0 1716415
ble conn=0
I (1718180) Cli: command 'state' ret 0
`

const STATE_OUTPUT_STARTUP = `
            <form action="cli" method="GET">
            <label for="x">CLI Command:</label><br>
            <input type="text" id="cli" name="cmd"><br>
            </form>
            I (1826900) Cli: cmd len 5: 'state'
I (1826900) Main: OTA vd 1 ldt 121 ldr 7 dip 0 waitsec 0 numf 1 wgi 1 iot r 0
scrname=wnd
value=0
mode=S_StartupToTempr
tempr=83.071825 C
temprB=99.459999 C
temprT=83.888885 C
ketl= ho 0 wd 0 nw 0 ipb 0 bf 0 tr 0
temps=183 F
tempsc=192 2C
units=1
clock=12:40
ticks=1826910 1820600 1825164
ble conn=0
I (1826930) Cli: command 'state' ret 0
`

const STATE_OUTPUT_CALIB = `
            <form action="cli" method="GET">
            <label for="x">CLI Command:</label><br>
            <input type="text" id="cli" name="cmd"><br>
            </form>         
            I (2307670) Cli: cmd len 5: 'state'
I (2307670) Main: OTA vd 1 ldt 121 ldr 7 dip 0 waitsec 0 numf 1 wgi 1 iot r 0
scrname=error screen - Calibration in progress.png
value=0
mode=S_Calib_Started+menu
tempr=85.524724 C
temprB=98.919998 C
temprT=84.500000 C
ketl= ho 0 wd 0 nw 0 ipb 0 bf 0 tr 0
temps=169 2C
tempsc=192 2C
units=1
clock=12:48
ticks=2307680 2260820 2305934
ble conn=0
I (2307710) Cli: command 'state' ret 0
`

const STATE_OUTPUT_CALIB_FINISH = `
            <form action="cli" method="GET">
            <label for="x">CLI Command:</label><br>
            <input type="text" id="cli" name="cmd"><br>
            </form>         
            I (2450920) Cli: cmd len 5: 'state'
I (2450920) Main: OTA vd 1 ldt 121 ldr 7 dip 0 waitsec 0 numf 1 wgi 1 iot r 0
scrname=error screen - Calibration in progress.png
value=0
mode=S_Calib_finish+menu
tempr=98.873996 C
temprB=98.919998 C
temprT=84.500000 C
ketl= ho 0 wd 0 nw 0 ipb 0 bf 0 tr 0
temps=169 2C
tempsc=192 2C
units=1
clock=12:50
ticks=2450930 2260820 2449184
ble conn=0
I (2450950) Cli: command 'state' ret 0
`

banner('parsers.test.js')
const accessory = makeInstance()

test('parse state from state output', () => {
  assert.strictEqual(accessory._parseState(STATE_OUTPUT), 0)
})

test('parse state from heating state output', () => {
  assert.strictEqual(accessory._parseState(STATE_OUTPUT_HEAT), 1)
})

test('parse state from hold state output', () => {
  assert.strictEqual(accessory._parseState(STATE_OUTPUT_HOLD), 1)
})

test('parse state from hold+menu state output', () => {
  assert.strictEqual(accessory._parseState(STATE_OUTPUT_HOLD_MENU), 1)
})

test('parse state from startup state output', () => {
  assert.strictEqual(accessory._parseState(STATE_OUTPUT_STARTUP), 1)
})

test('parse state from calibration state output', () => {
  assert.strictEqual(accessory._parseState(STATE_OUTPUT_CALIB), 1)
})

test('parse state from calibration finish state output', () => {
  assert.strictEqual(accessory._parseState(STATE_OUTPUT_CALIB_FINISH), 1)
})

test('parse temp from state output', () => {
  assert.strictEqual(accessory._parseTemp(STATE_OUTPUT), 50.491463)
})

test('parse target temp from state output', () => {
  assert.strictEqual(accessory._parseTargetTemp(STATE_OUTPUT), 96.111115)
})

test('parse temp in F to C', () => {
  assert.strictEqual(accessory._parseTempLine('tempr=212 F', 'tempr'), 100)
})

test('parse state from S_Heat string', () => {
  assert.strictEqual(accessory._parseState('mode=S_Heat'), 1)
})

test('parse first number fallback', () => {
  assert.strictEqual(accessory._parseFirstNumber('x=-12.5 y=3'), -12.5)
})
