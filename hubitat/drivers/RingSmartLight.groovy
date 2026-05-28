metadata {
    definition(
        name:        "Ring Smart Light",
        namespace:   "hubitat_ring",
        author:      "Todd",
        description: "Ring Bridge-connected smart light — on/off and dimming",
        version:     "1.0.0",
    ) {
        capability "Switch"             // switch: on | off
        capability "SwitchLevel"        // level: 0-100

        attribute "lastEvent", "string"
    }
}

def installed() { initialize() }
def updated()   { initialize() }

def initialize() {
    sendEvent(name: "switch", value: "off")
    sendEvent(name: "level",  value: 0)
}

// Switch commands

def on() {
    parent.sendBridgeCommand(device.deviceNetworkId, "on", [:])
}

def off() {
    parent.sendBridgeCommand(device.deviceNetworkId, "off", [:])
}

// SwitchLevel command

def setLevel(BigDecimal level, BigDecimal duration = 0) {
    def clamped = Math.min(100, Math.max(0, level.toInteger()))
    parent.sendBridgeCommand(device.deviceNetworkId, "setLevel", [level: clamped])
}
