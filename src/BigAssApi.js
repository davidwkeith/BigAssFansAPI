var dgram = require("dgram");
var BigAssFan = require('./BigAssFan');
var BigAssProperty = require('./BigAssProperty');
var { syncingCallback, retryCall, myLogWrapper } = require('./utils');

function FanMaster (numberOfExpectedFans) {
    this.allFans = {}; // Dictionary of fan name -> BigAssFan
    this.connectionOpen = false;
    this.fanPort = 31415;
    this.everyone = "255.255.255.255";
    this.server = dgram.createSocket("udp4");
    this.pollingIntervalForFans = 1000;
    this.dispatchForFans = {}
    this.numberOfExpectedFans = numberOfExpectedFans ? numberOfExpectedFans : 1;
    this.theAllFan = new BigAssFan("ALL", "ALL", this.everyone, this); // If you wanted to broadcast to everyone

    this.onFanConnection = function () {}; // Callback you can register for
    this.onFanFullyUpdated = function () {}; // Callback you can register for

    this.broadcastToFans = function(message) {
        this.sendRaw("<ALL;" + message + ">", this.everyone);
    }.bind(this);

    this.sendRaw = function(message, address) {
        myLogWrapper("Sending: " + message);
        var buffMessage = new Buffer(message);
        this.server.send(buffMessage, 0, buffMessage.length, this.fanPort, address);
    }.bind(this);

    this.rescanForFans = function(){
        this.broadcastToFans("DEVICE;ID;GET");
    }.bind(this)

    this.rescanUntilAllFans = function(){
        var pollForFans = function() {
            if (Object.keys(this.allFans).length < this.numberOfExpectedFans) {
                this.rescanForFans();
            } else {
                clearInterval(id);
            }
        }.bind(this);
        var id = setInterval(pollForFans, this.pollingIntervalForFans);
        pollForFans();
    }.bind(this)

    this.server.on('close', function(msg, rinfo) {
        this.connectionOpen = false;
    }.bind(this));

    handleNewFan = function(msg, address) {
        if (msg[0] == "ALL") {
            return; // Message not addressed to us
        }
        var deviceType = msg[4].split(",",1); // Grab first part of string before ","
        if (deviceType == "FAN") {
            var newFan = new BigAssFan(msg[0], msg[3], address, this);
            this.allFans[msg[0]] = newFan;
            this.onFanConnection(newFan);
            newFan.updateAll(function() {
                this.onFanFullyUpdated(newFan)
            }.bind(this));
        } else if (deviceType == "LIGHT") {

        } else if (deviceType == "SWITCH") {
            myLogWrapper("Skipping wall control - TODO : Add support for wall control")
        } else {
            myLogWrapper("Received message from unknown fan - rescanning");
            this.rescanForFans();
        }
    }.bind(this)

    this.server.on("message", (function (msg, rinfo) {
        myLogWrapper("server got: " + msg + " from " + rinfo.address + ":" + rinfo.port);
        var splitMessage = ("" + msg).replace(/<|>|\(|\)/g, "").split(";");
        var fanId = splitMessage.shift();
        if (this.dispatchForFans[fanId]) {
            this.dispatchForFans[fanId](splitMessage);
        } else {
            splitMessage.unshift(fanId)
            handleNewFan(splitMessage, rinfo.address);
        }
    }).bind(this));

    this.server.bind(this.fanPort, (function () {
        this.server.setBroadcast(true);
        this.connectionOpen = true;
        this.rescanUntilAllFans();
    }).bind(this));
}


/**
 * Each Big ass fan has a set of properties which in turn have fields
 */
function BigAssFan (name, id, address, master) {
    this.name = name;
    this.id = id ? id : name; // Use the name as the backup if no ID is available
    this.address = address;
    this.master = master;
    this.onPropertyUpdate = undefined;

    this.propertyTable = {};
    this.propertyListeners = [];
    this.maxRetries = 10;        // For properties
    this.waitTimeOnRetry = 250;  // For properties - in ms

    this.fan = new BigAssProperty('fan', this);
    this.fan.createGetField('isOn', ['FAN', 'PWR'], true, undefined, "ON", "OFF");
    this.fan.createGetField('speed', ['FAN', 'SPD'], true, 'ACTUAL'); // 0-7 on most fans - can also read min/max 
    this.fan.createGetField('min', ['FAN', 'SPD'], true, 'MIN');
    this.fan.createGetField('max', ['FAN', 'SPD'], true, 'MAX');
    this.fan.createGetField('auto', ['FAN', 'AUTO'], true, undefined, "ON", "OFF"); // Fan sensor enabled
    this.fan.createGetField('whoosh', ['FAN', 'WHOOSH'], true, "STATUS"); // ON, OFF
    this.fan.createGetField('isSpinningForwards', ['FAN', 'DIR'], true, undefined, "FWD", "REV");

    this.light = new BigAssProperty('light', this);
    this.light.createGetField('brightness', ['LIGHT', 'LEVEL'], true, 'ACTUAL'); // 0-16
    this.light.createGetField('min', ['LIGHT', 'LEVEL'], true, 'MIN');
    this.light.createGetField('max', ['LIGHT', 'LEVEL'], true, 'MAX');
    this.light.createGetField('auto', ['LIGHT', 'AUTO'], true, undefined, 'ON', 'OFF'); // Light sensor enabled
    this.light.createGetField('exists', ['DEVICE', 'LIGHT'], false, undefined, "PRESENT"); // Unknown false string.. WAY too lazy to unplug from fan

    this.sensor = new BigAssProperty('sensor', this);
    this.sensor.createGetField('isOccupied', ['SNSROCC', 'STATUS'], false, undefined, 'OCCUPIED', 'UNOCCUPIED');
    this.sensor.createGetField('minTimeout', ['SNSROCC', 'TIMEOUT'], true, 'MIN'); // Seconds (ie 3600000 is 60 min)
    this.sensor.createGetField('maxTimeout', ['SNSROCC', 'TIMEOUT'], true, 'MAX'); // Seconds
    this.sensor.createGetField('timeout', ['SNSROCC', 'TIMEOUT'], true, 'CURR');   // Seconds

    this.smartmode = new BigAssProperty('smartmode', this);
    this.smartmode.createGetField('smartmodeactual', ['SMARTMODE', 'ACTUAL'], true, undefined, 'OFF', 'COOLING', 'HEATING'); // Heating smartmode invokes LEARN;STATE;OFF and FAN;PWR;ON and FAN;SPD;ACTUAL;1 and WINTERMODE;STATE;ON and SMARTMODE;STATE;HEATING and SMARTMODE;ACTUAL;HEATING
    this.smartmode.createGetField('smartmodestate', ['SMARTMODE', 'STATE'], true, undefined, 'LEARN', 'COOLING', 'HEATING', 'FOLLOWSTAT'); // FOLLOWSTAT is the works with nest option, it is followed by SMARTMODE;ACTUAL;OFF command

    this.learn = new BigAssProperty('learn', this);
    this.learn.createGetField('isOn', ['LEARN', 'STATE'], true, undefined, 'LEARN', 'OFF'); // LEARN appears to be the on command rather than ON, ie LEARN;STATE;LEARN. When turned on, two or three commands follow, WINTERMODE;STATE;OFF and SMARTMODE;STATE;COOLING and SMARTMODE;ACTUAL;COOLING
    this.learn.createGetField('minSpeed', ['LEARN', 'MINSPEED'], true);
    this.learn.createGetField('maxSpeed', ['LEARN', 'MAXSPEED'], true);
    this.learn.createGetField('zeroTemp', ['LEARN', 'ZEROTEMP'], true); // This is a four digit number that represents the temperature in celsius (without a decimal) at which the fan automatically turns off in smart mode. For instance '2111' is 21.11 C which is 70 F 

    this.sleep = new BigAssProperty('sleep', this);
    this.sleep.createGetField('isOn', ['SLEEP', 'STATE'], true, undefined, 'ON', 'OFF');
    this.sleep.createGetField('smartIdealTemp', ['SMARTSLEEP', 'IDEALTEMP'], true);
    this.sleep.createGetField('minSpeed', ['SMARTSLEEP', 'MINSPEED'], true);
    this.sleep.createGetField('maxSpeed', ['SMARTSLEEP', 'MAXSPEED'], true);

    this.device = new BigAssProperty('device', this);
    this.device.createGetField('beeper', ['DEVICE', 'BEEPER'], true, undefined, 'ON', 'OFF');
    this.device.createGetField('indicators', ['DEVICE', 'INDICATORS'], true, undefined, 'ON', 'OFF');
    this.device.createGetField('winterMode', ['WINTERMODE', 'STATE'], true, undefined, 'ON', 'OFF');
    this.device.createGetField('height', ['WINTERMODE', 'HEIGHT'], true); // This is a whole number in meters, like 274 for 9 ft, 244 for 8 ft etc
    this.device.createGetField('token', ['NW', 'TOKEN'], false); // ??? token for what? reference to api.bigassfans.com in packets
    this.device.createGetField('dhcp', ['NW', 'DHCP'], true, undefined, 'ON', 'OFF');
    this.device.createGetField('fw', ['FW', 'FW000003'], false); // What is the FW000003 for in the query?
    this.device.createGetField('broadcastSSID', ['NW', 'SSID'], true);
    this.device.createGetField('isAccessPoint', ['NW', 'AP'], true, 'STATUS', 'ON', 'OFF');


    // Handles incoming messages from the fanMaster
    // Property listners are an array of two values
    //   - (1) : Array of property names to match on response
    //   - (2) : Callback to run
    this.handleMessage = function(message) {
        for (var key in this.propertyListeners) {
            var propertyListener = this.propertyListeners[key]
            if (!message || message.length < propertyListener[0].length) {
                continue;
            }
            var isSubset = true;
            for (var i = 0; i < propertyListener[0].length; i++) {
                if (propertyListener[0][i] != message[i]) {
                    isSubset = false;
                    break;
                }
            };
            if (isSubset) {
                propertyListener[1](message[i]);
            }
        }
    }.bind(this)

    this.master.dispatchForFans[name] = this.handleMessage;
    this.master.dispatchForFans[id] = this.handleMessage;

    this.updateAll = function(callback) {
        var syncCallback = syncingCallback(this.propertyTable, callback);
        for (var propertyKey in this.propertyTable) {
            this.propertyTable[propertyKey].updateAll(syncCallback);
        }
    }.bind(this)

    this.update = function(property, callback) {
        this[property].updateAll(callback)
    }.bind(this)

    this.send = function(msg) {
        var toSend = [this.id].concat(msg).join(";");
        this.master.sendRaw("<" + toSend + ">", address);
    }.bind(this)
}

exports.FanMaster = FanMaster;
exports.BigAssFan = BigAssFan;
