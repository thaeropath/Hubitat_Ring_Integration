metadata {
    definition(
        name:        "Ring Alarm Controller",
        namespace:   "hubitat_ring",
        author:      "Todd",
        description: "Ring Alarm — mode status (armed away / armed home / disarmed) with optional arm/disarm",
        version:     "1.1.0",
    ) {
        attribute "securityKeypad", "string"   // armed away | armed home | disarmed

        attribute "lastUser",  "string"
        attribute "lastEvent", "string"

        command "armAway"
        command "armHome"
        command "disarm"
    }
}

def installed() { initialize() }
def updated()   { initialize() }

def initialize() {
    sendEvent(name: "securityKeypad", value: "disarmed")
}

// Arm/disarm commands — delegate to parent app → bridge.
// The bridge enforces ALARM_CONTROL; if set to false it returns 403
// and logs a warning without changing the alarm state.

def armAway() {
    parent.sendBridgeCommand(device.deviceNetworkId, "arm", [mode: "away"])
}

def armHome() {
    parent.sendBridgeCommand(device.deviceNetworkId, "arm", [mode: "home"])
}

def disarm() {
    parent.sendBridgeCommand(device.deviceNetworkId, "disarm", [:])
}
