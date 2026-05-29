metadata {
    definition(
        name:        "Ring Motion Sensor",
        namespace:   "hubitat_ring",
        author:      "Todd",
        description: "Ring alarm hub PIR motion sensor — motion active/inactive",
        version:     "1.0.0",
    ) {
        capability "MotionSensor"   // motion: active | inactive

        attribute "lastEvent", "string"
    }
}

def installed() { initialize() }
def updated()   { initialize() }

def initialize() {
    sendEvent(name: "motion", value: "inactive")
}
