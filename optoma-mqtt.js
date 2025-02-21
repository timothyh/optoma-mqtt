'use strict'

// queueCommand(['query', 'info_string'])
// queueCommand(['set', 'power', 'on'])
// queueCommand(['set', 'input', 'hdmi1'])

const {
    SerialPort
} = require('serialport')
const mqtt = require('mqtt')
const util = require('util')
const fs = require('fs')
const stringify = require('json-stable-stringify')

const mh = require('./my-helpers')

const config = mh.readConfig('./config.json')

const lookups = require('./lookups.json')
const commands = require('./commands.json')

var device = {}

var mqttConf = config.mqtt_conf

var rawData = config.raw_data ? true : false
var verbose = config.verbose ? true : false
var debug = config.debug ? true : false

mh.setSeparator('_')

const cmdPrefix = '~' + ('00' + config.device_id).slice(-2)

var mqttActivity = Date.now()

var lastRecvTime = Date.now()
var lastSendTime = Date.now()

// Poll device for status
var devicePoll = true
// Device has power from outlet
var powerState = true
// Device is powered on
var deviceState = false
// Device is warming up but not ready for commands
var warming = false
// Device is cooling down
var cooling = false
//
var lastStatus = -1

var amxInfo = {}
var lastInfoString = {}

var lastCommand = []

// Commands that work regardless of device state
var powerCmds = ['AMX', 'key.info', 'key.poweron', 'key.power_on', 'query.power', 'set.power.on', 'query.info_string']

// Commands that initiate a device shutdown
var shutdownCmds = ['set.power.off', 'key.poweroff', 'key.power_off']

////////////////////////////////////////////////////////////////////////////////
// Info Values plus
// 97 - 'off'
// 98 - 'ready'
// 99 - 'no power'
//
// Device cycle sequence is
// 99 - no power
// 0 - standby
// 1 - warming
// 98 - on
// Projector running ....
// 2 - cooling
// 0 - standby
// 97 - off
// 99 - no power
//
function _setStatus(status) {
    if (status === lastStatus) return

    lastStatus = status

    publishState('status', lookups.INFO[status.toString()], false)
}

function getStatus() {
    return lastStatus
}

function _setDeviceState(state) {
    // Force to proper boolean
    state = (state ? true : false)

    if (state === deviceState) return

    deviceState = state

    if (state) {
        warming = false
        publishState('power', lookups.OK.power['1'], false)
    } else {
        publishState('power', lookups.OK.power['0'], false)
    }
}

function getDeviceState() {
    return deviceState
}

var firstInput = true

function _processInput(input) {
    if (input.length == 0) return

    if (rawData) console.log('RX: %s', input)

    lastRecvTime = Date.now()
    if ((!powerState) || firstInput) {
        console.log('Connected to device')
        processSetup('on_start')
        firstInput = false
    }
    powerState = true
    devicePoll = true

    if (input.slice(0, 4) === 'INFO') {
        var status = parseInt(input.slice(4))

        _setStatus(status)

        switch (status) {
            // Device has just come alive
            case 0:
                _setDeviceState(false)
                if (cooling) _setStatus(97)
                cooling = false
                warming = false
                lastInfoString = {}
                break
            case 1:
                warming = true
                _queueSendIn(500, true)
                break
            case 2:
                cooling = true
                break
        }
        if ((status <= 2) && (!Object.keys(amxInfo).length)) queueCommandFirst(['AMX'])
        return
    }

    if (input === 'F') {
        console.warn("Command failed: %s (%s)", lastCommand[1], lastCommand[0].join('.'))
    } else if (input === 'P') {
        if (lastCommand[0].join('.') === 'set.power.on') {
            warming = true
            _queueSendIn(7000, true)
            return
        }
    } else if (input.slice(0, 2).toUpperCase() === 'OK') {
        if (lastCommand[0].join('.') === 'query.info_string') {
            _parseInfoString(input.slice(2))
        } else if (lastCommand[0].join('.') === 'query.power') {
            switch (input.slice(2)) {
                case '0':
                case '2':
                    _setDeviceState(false)
                    break
                case '1':
                    warming = false
                    if (!deviceState) {
                        _setStatus(98)
                        _setDeviceState(true)
                        processSetup('on_ready')
                    }
                    break
            }
        } else if (lastCommand[0][0] === 'query') {
            var val = parseInt(input.slice(2))
            if (lastCommand[0][1] in lookups.OK) {
                try {
                    var attr = lookups.OK[lastCommand[0][1]][val.toString()]
                    if (attr) publishState(lastCommand[0][1], attr, true)
                } catch {
                    console.warn('Unexpected response: ', lastCommand[0].join('.'), input.slice(2))
                }
            } else {
                publishState(lastCommand[0][1], val, true)
            }
        }
    } else if (input.slice(0, 3) === 'AMX') {
        for (const value of input.slice(4).split(/<-([^>]*)>/)) {
            if (value) {
                var tmp = value.split('=')
                device[tmp[0].toLowerCase()] = tmp[1]
            }
        }
        console.log("Device: %s", util.inspect(device).replace(/[^\u0021-\u007E]+/g, ' '))
        if ('amx' in config) {
            var ok = true
            for (const attr in config.amx) {
                if (attr in device) {
                    if (config.amx[attr].toLowerCase() !== device[attr].toLowerCase()) {
                        ok = false
                        console.error("Mismatched AMX value - attribute: '%s' wanted: '%s' got: '%s'", attr, config.amx[attr], device[attr])
                    }
                }
            }
        }
        if (!ok) process.exit(10)
        if (verbose) console.log("AMX value checks passed")

        amxInfo = device
    }
    _queueSendIn(250, true)
}

function processSetup(when) {
    if (!('setup' in config)) return
    if (!(when in config.setup)) return

    if (verbose) console.log("Running '%s' setup", when)

    config.setup[when].forEach(setting => {
        queueCommand(setting.split('.'))
    })
}

function _parseInfoString(str) {
    var info = {}

    info.power = str.slice(0, 1)

    if (str.length == 11) {
        // abbbbcdddde
        info.lampHour = parseInt(str.slice(1, 5))
        info.input = parseInt(str.slice(5, 6))
        info.firmware = str.slice(6, 10)
        info.displayMode = parseInt(str.slice(10, 11))
    } else if (str.length == 13) {
        info.lampHour = parseInt(str.slice(1, 6))
        info.input = parseInt(str.slice(6, 8))
        info.firmware = str.slice(8, 11)
        info.displayMode = parseInt(str.slice(11, 13))
    } else if (str.length == 14) {
        // abbbbbccddddee
        info.lampHour = parseInt(str.slice(1, 6))
        info.input = parseInt(str.slice(6, 8))
        info.firmware = str.slice(8, 12)
        info.displayMode = parseInt(str.slice(12, 14))
    }

    var changed = false

    switch (info.power) {
        case '0':
        case '2':
            _setDeviceState(false)
            break
        case '1':
            _setDeviceState(true)
            break
    }

    if (info.input != lastInfoString.input) {
        changed = true
        if (info.input != 0) {
            publishState('input', lookups.OK.input[info.input.toString()], false)
        }
    }
    if (info.displayMode != lastInfoString.displayMode) {
        changed = true
        if (info.displayMode != 0) {
            publishState('display_mode', lookups.OK.display_mode[info.displayMode.toString()], false)
        }
    }

    if (verbose && changed) console.log("Info update: %s", util.inspect(info).replace(/[^\u0021-\u007E]+/g, ' '))

    lastInfoString = info
}

var cmdQueue = []
var inpBuffer = []
var queueTimer

// Place command at top of queue
function queueCommandFirst(cmd) {
    cmdQueue.unshift(cmd)
    _queueSendIn(100, false)
}

// Add command to end of queue
function queueCommand(cmd) {
    cmdQueue.push(cmd)
    _queueSendIn(100, false)
}

function _queueSendIn(interval, force) {
    if ((!force) && queueTimer) return

    clearTimeout(queueTimer)
    queueTimer = setTimeout(_queueSendNext, interval)
}

function _queueClear() {
    clearTimeout(queueTimer)
    queueTimer = undefined
    cmdQueue = []
}

function _queueSendNext() {
    clearTimeout(queueTimer)
    queueTimer = undefined

    var nextCmd = cmdQueue.shift()
    if (!nextCmd) return

    var done = false

    if (nextCmd[0] === 'pause') {
        var delay = 1000 * parseInt(nextCmd[1])
        if (delay > 0) _queueSendIn(delay, true)
        return
    } else if (nextCmd.slice(0, 2).join('.') === 'set.poll') {
        // Turn device polling on or off
        console.log("Device polling: %s", nextCmd.join('.'))
        switch (nextCmd[2]) {
            case 'on':
                devicePoll = true
                break
            case 'off':
                devicePoll = false
                break
        }
        done = true
    } else if (!powerState) {
        done = true
    } else if (powerCmds.includes(nextCmd.join('.'))) {
        //
    } else if (nextCmd[0] === 'setup') {
        //
    } else if (warming) {
        if (verbose) console.log('Still warming up')
        cmdQueue.unshift(nextCmd)
        done = true
    } else if (!deviceState) {
        console.warn("Device off - Can't send", nextCmd.join('.'))
        done = true
    }

    if (done) {
        _queueSendIn(1000, false)
        return
    }

    var rawCmd
    if (nextCmd[0] === 'AMX') {
        rawCmd = 'AMX'
    } else {
        try {
            if (nextCmd[0] in commands) {
                // Example 'set' -> 'power.on'
                rawCmd = commands[nextCmd[0]][nextCmd.slice(1).join('.')]
                if (rawCmd === undefined) {
                    // Example 'set' 'volume' '50'
                    if (nextCmd[1] in commands[nextCmd[0]]) {
                        var tmp = commands[nextCmd[0]][nextCmd[1]]
                        rawCmd = util.format(tmp, nextCmd[2])
                    }
                }
            }
        } catch {}
        if (rawCmd !== undefined) rawCmd = cmdPrefix + rawCmd
    }
    if (rawCmd !== undefined) {
        if (debug) console.log("Send command: %s [%s]", nextCmd.join('.'), rawCmd)
        if (rawData) console.log("TX: %s", rawCmd)
        port.write(rawCmd + "\r")
        lastCommand[0] = nextCmd
        lastCommand[1] = rawCmd
        lastSendTime = Date.now()
    } else {
        console.warn('Unexpected command: ', nextCmd.join('.'))
    }
    // Safety
    _queueSendIn(2000, false)
}

var publishedState = {}

function publishState(attr, val, force = false) {
    if (!force) {
        if (publishedState[attr] === val) return
        publishedState[attr] = val
    }

    mqttClient.publish(mqttConf.topic_prefix + '/' + attr, (typeof val === 'string') ? val : JSON.stringify(val))

    if (verbose) console.log("Device state update: %s=%s", attr, val)
}

////////////////////////////////////////////////////////////////////////////////
const port = new SerialPort({
    path: config.serial_device,
    echo: false,
    parity: 'none',
    baudRate: config.baud_rate
})

// Switches the port into 'flowing mode'
port.on('data', function(data) {

    for (var c of data.entries()) {
        if (c[1] >= 32) {
            inpBuffer.push(String.fromCharCode(c[1]))
        } else {
            _processInput(inpBuffer.join(''))
            inpBuffer = []
        }
    }
})

if (mqttConf.cafile) {
    mqttConf.cacertificate = [fs.readFileSync(mqttConf.cafile)]
}

var mqttClient = mqtt.connect({
    ca: mqttConf.cacertificate,
    host: mqttConf.host,
    port: mqttConf.port,
    protocol: mqttConf.protocol,
    username: mqttConf.username,
    password: mqttConf.password,
    keepalive: mqttConf.keepalive,
    will: config.status_topic ? {
        topic: config.status_topic,
        payload: 'stop'
    } : undefined
})

mqttClient.on('connect', function() {
    console.log('Connected to MQTT Broker')
    mqttClient.subscribe(mqttConf.ping_topic)
    mqttClient.subscribe(mqttConf.topic_prefix + '/+/set')
    mqttClient.subscribe(mqttConf.topic_prefix + '/+/query')
    mqttClient.subscribe(mqttConf.topic_prefix + '/key')
})

// MQTT Activity
mqttClient.on('close', function() {
    console.warn('MQTT connection closed')
    process.exit(1)
})

mqttClient.on('message', function(topic, payload) {
    mqttActivity = Date.now()

    if (topic === mqttConf.ping_topic) {
        return
    }
    var cmd = []
    topic = topic.toLowerCase()

    //Match either ..../key or ..../key/set
    if (topic.match(/\/key$/i) || topic.match(/\/key\/set$/i)) {
        cmd[0] = 'key'
        cmd[1] = payload.toString().toSlug()
    } else if (topic.match(/\/set$/i)) {
        cmd[0] = 'set'
        cmd[1] = topic.replace(mqttConf.topic_prefix.toLowerCase() + '/', '').replace(/\/set$/i, '').toSlug()
        if (payload.length) cmd[2] = payload.toString().toLowerCase()
    } else if (topic.match(/\/query$/i)) {
        cmd[0] = 'query'
        cmd[1] = topic.replace(mqttConf.topic_prefix.toLowerCase() + '/', '').replace(/\/query$/i, '').toSlug()
    }

    if (verbose) console.log("Command received %s", cmd.join('.'))

    // Use cached values to respond to these queries regardless of whether device has power
    if (cmd.join('.') === 'query.power') {
        publishState('power', lookups.OK.power[(deviceState ? '1' : '0')], true)
    } else if (cmd.join('.') === 'query.status') {
        publishState('status', lookups.INFO[lastStatus.toString()], true)
    } else if (cmd.slice(0, 2).join('.') === 'set.poll') {
        queueCommand(cmd)
    } else if (powerState) {
        if (deviceState && shutdownCmds.includes(cmd.join('.'))) {
            processSetup('on_shutdown')
        }
        queueCommand(cmd)
    } else {
        console.warn("No power to device - Ignoring %s", cmd.join('.'))
    }
})

// Device Keepalive
setInterval(function() {
    if (!devicePoll) return

    if (deviceState) {
        queueCommandFirst(['query', 'info_string'])
    } else {
        queueCommandFirst(['query', 'power'])
        // Extra polling while warming up
        if (warming) {
            queueCommandFirst(['query', 'power'])
            _queueSendIn(5000, true)
        }
    }
}, 10000)

// MQTT Keepalive
setInterval(function() {
    mqttClient.publish(mqttConf.ping_topic, JSON.stringify({
        timestamp: Date()
    }))
}, 60000)

// Watch for inactivity
setInterval(function() {
    var now = Date.now()

    var mqtt_last = (now - mqttActivity) / 1000.0
    if (mqtt_last >= 90) {
        console.warn('Exit due to MQTT inactivity')
        process.exit(10)
    }

    if (devicePoll && powerState) {
        var recv_last = (now - lastRecvTime) / 1000.0

        if (recv_last > 31) {
            _setDeviceState(false)
            powerState = false
            warming = false
            cooling = false
            amxInfo = {}
            console.warn('No power to device')
            _setStatus(99)
        }
    }
}, 5000)

queueCommandFirst(['AMX'])