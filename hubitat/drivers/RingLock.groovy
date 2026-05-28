metadata {
    definition(
        name:        "Ring Lock",
        namespace:   "hubitat_ring",
        author:      "Todd",
        description: "Ring door lock — lock/unlock with user attribution",
        version:     "1.0.0",
    ) {
        capability "Lock"               // lock: locked | unlocked

        attribute "lastUser",  "string"
        attribute "lastEvent", "string"
    }
}

def installed() { initialize() }
def updated()   { initialize() }

def initialize() {
    sendEvent(name: "lock", value: "unknown")
}

// Lock commands — delegate to parent app → bridge

def lock() {
    parent.sendBridgeCommand(device.deviceNetworkId, "lock", [:])
}

def unlock() {
    parent.sendBridgeCommand(device.deviceNetworkId, "unlock", [:])
}
