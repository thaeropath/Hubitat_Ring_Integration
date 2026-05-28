metadata {
    definition(
        name:        "Ring Contact Sensor",
        namespace:   "hubitat_ring",
        author:      "Todd",
        description: "Ring contact sensor — open/closed state",
        version:     "1.0.0",
    ) {
        capability "ContactSensor"      // contact: open | closed

        attribute "lastEvent", "string"
    }
}

def installed() { initialize() }
def updated()   { initialize() }

def initialize() {
    sendEvent(name: "contact", value: "closed")
}
