const BigAssProperty = require('./BigAssProperty');
const { syncingCallback, retryCall, myLogWrapper } = require('./utils');

module.exports = function BigAssFan (name, id, address, master) {
    this.type = 'fan';
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
    this.handleMessage = message => {
        for (const key in this.propertyListeners) {
            const propertyListener = this.propertyListeners[key];
            if (!message || message.length < propertyListener[0].length) {
                continue;
            }
            let isSubset = true;
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
    }

    this.master.dispatchForDevices[name] = this.handleMessage;
    this.master.dispatchForDevices[id] = this.handleMessage;

    this.updateAll = callback => {
        const syncCallback = syncingCallback(this.propertyTable, callback);
        for (const propertyKey in this.propertyTable) {
            this.propertyTable[propertyKey].updateAll(syncCallback);
        }
    }

    this.update = (property, callback) => {
        this[property].updateAll(callback)
    }

    this.send = msg => {
        const toSend = [this.id].concat(msg).join(";");
        this.master.sendRaw(`<${toSend}>`, address);
    }
};
