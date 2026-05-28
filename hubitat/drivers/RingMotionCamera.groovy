metadata {
    definition(
        name:        "Ring Motion Camera",
        namespace:   "hubitat_ring",
        author:      "Todd",
        description: "Ring camera or doorbell — motion events and doorbell ding",
        version:     "1.0.0",
    ) {
        capability "MotionSensor"       // motion: active | inactive
        capability "PushableButton"     // doorbell ding fires button 1

        attribute "lastEvent", "string"
    }
}

def installed() { initialize() }
def updated()   { initialize() }

def initialize() {
    sendEvent(name: "motion",          value: "inactive")
    sendEvent(name: "numberOfButtons", value: 1)
}
