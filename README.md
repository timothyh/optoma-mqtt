# Serial Optoma to MQTT Gateway

Gateway between Optoma Projector with serial interface and MQTT

Used on Raspberry Pi 3b using 64bit Raspberry Pi OS and nodejs from Nodesource

Used with a single Optoma projector

## Installation

Install Nodejs - Nodesource stable version (currently 22) suggested.

Git pull/unpack files into directory - /opt/optoma-mqtt suggested.

If using systemd, verify contents of optoma-mqtt.service

Create a config.json file - See config.json.sample

See install.sh script to complete installation - This will create a nodejs user and systemd optoma-mqtt service

Note that access to the appropriate serial device is needed. Other than that that no special
permissions are needed for this gateway. And no state is stored so all files can be read-only.

## Configuration

All configuration is in `config.json`. See `config.json.sample` for an annotated version. After changes,
use `jq` to verify integrity of file.

In `config.json` there can be a `setup` section defining projector commands to be executed at various stages in the
projector power-up/power-down sequences. This can be used to force projector into a known state.

Within `setup` there are the following sub-sections:-

- `on_start` - Executed when projector initially powers on. Very few commands seem to work at this stage
- `on_ready` - Executed when projector is fully warmed up. All commands seems to work here
- `on_shutdown` - Executed before a power-off is issued. Obviously this is only effective when the power-off
    is issued by this program.

In addition to the projector commands there is also a `pause` command (example: `pause.5`) in case delays are needed in a sequence.

## MQTT Messages

Assuming a topic prefix of home/optoma/myroom/ the following MQTT topics are available

- `home/optoma/myroom/{attribute}/set` - Sets value
- `home/optoma/myroom/{attribute}/query` - Queries value. Response will be published as home/optoma/myroom/{attribute}
- `home/optoma/myroom/key` - Simulates remote control keypress. Payload defines key to simulate.

- `home/optoma/myroom/{attribute}` - Attribute value published by this gateway

#### Attributes

Include
- `status` - Current status of projector - query/publish only
- `power` - payload is on or off
- `mute` - payload is on or off
- `volume` - payload is numeric value
- `brightness` - numeric value - range -50 to +50
- `contrast` - numeric value - range -50 to 50
- `input` - hdmi1, hdmi2 and others - varies by projector
- `display_mode` - values include "bright", "movie" - varies by projector
- `poll` - turns polling of the projector "off" - set only

#### Examples
Using `mosquitto_pub`

- Power On
```mosquitto_pub -t home/optoma/myroom/power/set -m on```
- Set input to HDMI1 
```mosquitto_pub -t home/optoma/myroom/input/set -m hdmi1```

#### Status Values

Key status values for day-to-day operation are
- `standby` - Projector has power and ready to accept a `power on` command
- `warming_up` - Projector is powering up but not ready for use
- `cooling_down` - Projector is powering down
- `off` - Projector has finished powering down. It's safe to turn off power
- `ready` - Projector is warmed up and ready for use
- `no_power` - Projector is not responding

There are also a number of other status values related to internal operation of projector. See `lookups.json` and projector documentation.

## Troubleshooting

I've not had a lot of issues so have limited troubleshooting experience. But here are some things to try:-
- Check the logs - If systemd is being used something like ```journalctl -u optoma-mqtt.service``` will show the logs
- If projector is of indeterminate configuration try a factory reset
- This gateway uses the serial interface. If the cable is too long, or connectors flaky, characters may be lost and this gateway will not
  work. To check, set the `raw_data` option in config.json to true and see what is logged. This is some sample output with `raw_data` set to `true`.
```TX: ~0011 0
RX: P
TX: ~00511 0
RX: P
TX: ~00150 1
RX: Ok10004007C00303
TX: ~0012 1
RX: P
TX: ~0020 2
RX: F
Command failed: ~0020 2 (set.display_mode.bright)
TX: ~00150 1
RX: Ok10004007C00303
```
- There appear to be some slight varients to the Optoma protocol based on projector. If the logging shows serial commands being rejected check the documentation for your specific projector.
  
## Projector Polling

In addition to monitoring `INFO` messages, this gateway polls the projector every 10 seconds to check status. This is used to check whether
the projector has power, whether it's powered up or down and, when powered up, the `input` and `display_mode` attributes.

This can be turned off by setting the `poll` attribute". Note that polling automatically restarts when the projector shows any kind of activity.

## Extending/adding projector commands

#### `commands.json`
Projector commands are all configured in this file. It has the following sections:-
- `set`, `query` and `key` which are used by the equivalent MQTT operations.
- `setup` which is just used internally for setup commands

  Optoma projector commands are well documented on the web. Just search for "optoma rs232 protocol".

#### `lookup.json`
Maps the numeric status values returned by the projector to text strings used in the
MQTT messages. There are two sections:-
`INFO` - Maps to the status values returned with `INFO` messages
`OK` - Maps values returned in `OK` messages. There are lookup tables for each kind of value

Note hash tables are used for "numeric" values

Organized by operation - set, query, key which are used by MQTT, and setup which is only used in the config.json file.

Command is then defined as attribute plus (optionally) payload.

For example
topic: `home/optoma/myroom/input/set`, payload: `hdmi1` will be looked up as `set` -> `input.hdmi1`
If there's no match on command + payload, `set` operations lookup just the attribute and treat the
resulting value as a util.format string to format the payload.

## Important

This gateway is tested with a single projector but should work with any projector using the Optoma command sequences.
However, your mileage may vary.

Obviously, there is no warranty and you use this at your own risk.

This is "good enough for me" but git pull requests will be accepted so long as they perform a useful function and doesn't break the code for my own use.
Any code that looks like a security risk will be rejected.

