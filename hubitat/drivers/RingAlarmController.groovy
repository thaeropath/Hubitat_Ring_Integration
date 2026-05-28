metadata {
    definition(
        name:        "Ring Alarm Controller",
        namespace:   "hubitat_ring",
        author:      "Todd",
        description: "Ring Alarm — arm/disarm with user attribution",
        version:     "1.0.0",
    ) {
        capability "SecurityKeypad"     // securityKeypad: armed away | armed home | disarmed

        attribute "lastUser",  "string"
        attribute "lastEvent", "string"
    }
}

def installed() { initialize() }
def updated()   { initialize() }

def initialize() {
    sendEvent(name: "securityKeypad", value: "disarmed")
}

// SecurityKeypad commands — delegate to parent app → bridge

def armAway(String pinCode = null) {
    parent.sendBridgeCommand(device.deviceNetworkId, "arm", [mode: "away"])
}

def armHome(String pinCode = null) {
    parent.sendBridgeCommand(device.deviceNetworkId, "arm", [mode: "home"])
}

def disarm(String pinCode = null) {
    parent.sendBridgeCommand(device.deviceNetworkId, "disarm", [:])
}
