KETTLE_HOST="${KETTLE_HOST:-192.168.1.32}"

function stag() {
  local cmd="${*// /+}"
  curl "http://${KETTLE_HOST}/cli?cmd=$cmd"
}

# Set temperature in Celsius by converting to Fahrenheit and using settempr.
settempc() {
  local c="$1"
  if [[ -z "$c" ]]; then
    echo "usage: settempc <celsius>"
    return 1
  fi
  if ! [[ "$c" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
    echo "error: celsius must be a number"
    return 1
  fi
  local f
  f=$(awk -v c="$c" 'BEGIN { printf "%.0f", (c * 9 / 5) + 32 }')
  stag setsetting settempr "$f"

  # Now ensure the kettle is in the S_heat mode
  stag ss S_Heat
}

# Help data as "cmd:description" lines (portable format)
_STAG_HELP_DATA="reset:reset
state:print state
statesave:save state after given time (ms)
prtsaved:print saved state
setstate:set state
ss:set state
shot:print screenshot
refresh:refresh gui
sleepms:sleep given time ms
setsetting:setsetting name integer_value
setsettingd:setsetting name double_value
setsettings:setsetting name string_value
setsettingb:setsetting name hexstring
clrsettings:delete all settings
prtsettings:print settings
prts:print settings
prtclock:print clock
setclock:setclock hour min [sec]
incclock:increment clock minutes
incticks:increase tick count
setanalog:set clock mode = analog
setdigital:set clock mode = digital
setaltitudem:set altitude (meters)
setaltitudef:set altitude (feet)
setunitsc:set units = celsius
setunitsf:set units = fahrenheit
fwinfo:print firmware info
setpart:set boot partition name
eraseotherpart:erase non-current OTA part
heapprt:print heap info
lvglinfo:print lvgl mem use
lvglpon:enable lvgl alloc print
lvglpoff:disable lvgl alloc print
logprt:print small log
gpioset:gpioset pin 0|1
heaton:set GPIO HEAT High
heatoff:set GPIO HEAT Low
warmon:set GPIO WARM High
warmoff:set GPIO WARM Low
warmduty:enable WARM pwm using duty percent
rmtflt:set filter for rmt
pwmprt:print pwm regs
temp:print tempr min/max/av
tstprd:set tempr stat/notif period ms
buz:buz freq_hz duty_13_bit dur_ms (or buz sos)
wifiprt:print WiFi config
wifierase:erase wifi sap config
wifisappw:enter/save wifi sap password
wifistapw:enter/save wifi sta password
wifistassid:enter/save wifi sta ssid [pw]
wifioff:turn wifi off
wifion:turn wifi on
wifisap:start wifi softap mode
wifista:start wifi station mode
provreset:reset WiFi config (forget AP)
mdns:start mdns
blesec:start ble security
bleen:enable/start BLE
bledis:disable/stop BLE
iot:test iot
httpdwn:download file via HTTP and drop
httpfw:download/install FW via HTTP
httptest:verify HTTPS server follows rules
1:short press button 1
1d:push button 1
1u:release button 1
2:short press button 2
2d:push button 2
2u:release button 2
q:rotate dial left
w:rotate dial right
left:rotate dial left
right:rotate dial right
bc:print button click count
read_adc:read adc voltage
temp_offset:read temperature offset
adcsamples:number of adc samples
set_period:set pwm period in seconds
max_duty:set triac max duty
min_duty:set triac min duty
help:show help"

# Extract just command names
_STAG_COMMANDS=$(echo "$_STAG_HELP_DATA" | cut -d: -f1 | tr '\n' ' ')

# Get help for a command
_stag_help_for() {
  echo "$_STAG_HELP_DATA" | grep "^$1:" | cut -d: -f2-
}

# Returns hint for a given command and argument position
_stag_get_hint() {
  local cmd="$1" pos="$2"
  case "$cmd" in
    statesave) [[ $pos -eq 2 ]] && echo "<time_ms>" ;;
    setstate|ss) [[ $pos -eq 2 ]] && echo "<state>" ;;
    sleepms) [[ $pos -eq 2 ]] && echo "<time_ms>" ;;
    setsetting)
      [[ $pos -eq 2 ]] && echo "<name>"
      [[ $pos -eq 3 ]] && echo "<integer_value>" ;;
    setsettingd)
      [[ $pos -eq 2 ]] && echo "<name>"
      [[ $pos -eq 3 ]] && echo "<double_value>" ;;
    setsettings)
      [[ $pos -eq 2 ]] && echo "<name>"
      [[ $pos -eq 3 ]] && echo "<string_value>" ;;
    setsettingb)
      [[ $pos -eq 2 ]] && echo "<name>"
      [[ $pos -eq 3 ]] && echo "<hexstring>" ;;
    setclock)
      [[ $pos -eq 2 ]] && echo "<hour>"
      [[ $pos -eq 3 ]] && echo "<min>"
      [[ $pos -eq 4 ]] && echo "<sec>" ;;
    incclock) [[ $pos -eq 2 ]] && echo "<minutes>" ;;
    incticks) [[ $pos -eq 2 ]] && echo "<ticks>" ;;
    setaltitudem|setaltitudef) [[ $pos -eq 2 ]] && echo "<altitude>" ;;
    setpart) [[ $pos -eq 2 ]] && echo "<partition_name>" ;;
    gpioset)
      [[ $pos -eq 2 ]] && echo "<gpio>"
      [[ $pos -eq 3 ]] && echo "0 1" ;;
    warmduty) [[ $pos -eq 2 ]] && echo "<duty_percent>" ;;
    rmtflt) [[ $pos -eq 2 ]] && echo "<filter>" ;;
    tstprd) [[ $pos -eq 2 ]] && echo "<period_ms>" ;;
    buz)
      [[ $pos -eq 2 ]] && echo "sos <freq_hz>"
      [[ $pos -eq 3 ]] && echo "<duty_13_bit>"
      [[ $pos -eq 4 ]] && echo "<dur_ms>" ;;
    wifisappw) [[ $pos -eq 2 ]] && echo "<password>" ;;
    wifistapw) [[ $pos -eq 2 ]] && echo "<password>" ;;
    wifistassid)
      [[ $pos -eq 2 ]] && echo "<ssid>"
      [[ $pos -eq 3 ]] && echo "<password>" ;;
    httpdwn) [[ $pos -eq 2 ]] && echo "<url>" ;;
    adcsamples) [[ $pos -eq 2 ]] && echo "<num_samples>" ;;
    set_period) [[ $pos -eq 2 ]] && echo "<seconds>" ;;
    max_duty|min_duty) [[ $pos -eq 2 ]] && echo "<duty>" ;;
  esac
}

if [[ -n "$ZSH_VERSION" ]]; then
  # Zsh completion with descriptions
  _stag_completions_zsh() {
    local -a commands_with_desc

    if [[ $CURRENT -eq 2 ]]; then
      # Parse help data into zsh format
      while IFS=: read -r cmd desc; do
        commands_with_desc+=("$cmd:$desc")
      done <<< "$_STAG_HELP_DATA"
      _describe 'command' commands_with_desc
    else
      local cmd="${words[2]}"
      local hint=$(_stag_get_hint "$cmd" $CURRENT)
      if [[ -n "$hint" ]]; then
        local -a hints
        hints=(${=hint})
        _describe 'argument' hints
      fi
    fi
  }
  if type compdef >/dev/null 2>&1; then
    compdef _stag_completions_zsh stag
  fi

  _settempc_completion_zsh() {
    if [[ $CURRENT -eq 2 ]]; then
      local -a hints
      hints=("<celsius>")
      _describe 'argument' hints
    fi
  }
  if type compdef >/dev/null 2>&1; then
    compdef _settempc_completion_zsh settempc
  fi

elif [[ -n "$BASH_VERSION" ]]; then
  # Bash completion with descriptions
  _stag_completions_bash() {
    local cmd="${COMP_WORDS[1]}"
    local cur="${COMP_WORDS[COMP_CWORD]}"

    if [[ $COMP_CWORD -eq 1 ]]; then
      COMPREPLY=($(compgen -W "$_STAG_COMMANDS" -- "$cur"))
      # Show help if single match
      if [[ ${#COMPREPLY[@]} -eq 1 ]]; then
        local help=$(_stag_help_for "${COMPREPLY[0]}")
        [[ -n "$help" ]] && echo -e "\n  ${COMPREPLY[0]}: $help"
      fi
    else
      local hint=$(_stag_get_hint "$cmd" $COMP_CWORD)
      if [[ -n "$hint" ]]; then
        COMPREPLY=($(compgen -W "$hint" -- "$cur"))
      fi
    fi
  }
  complete -F _stag_completions_bash stag

  _settempc_completion_bash() {
    local cur="${COMP_WORDS[COMP_CWORD]}"
    if [[ $COMP_CWORD -eq 1 ]]; then
      COMPREPLY=($(compgen -W "<celsius>" -- "$cur"))
    fi
  }
  complete -F _settempc_completion_bash settempc
fi
