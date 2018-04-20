var bigAssApi = require("../src/BigAssApi");

var myMaster = new bigAssApi.FanMaster(4); // Expect only one device in my setup

myMaster.onDeviceFullyUpdated = function(myBigAss){
	console.log("Found a new device with name '" + myBigAss.name + "'")
	console.log("and identifier: '" + myBigAss.id + "'\n")
}
