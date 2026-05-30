definition(
    name:        "Ring Integration",
    namespace:   "hubitat_ring",
    author:      "Todd",
    description: "Bridges Ring cameras, sensors, alarm, and locks to Hubitat via a local Node.js bridge server",
    category:    "Security",
    iconUrl:     "",
    iconX2Url:   "",
    version:        "1.1.0",
    singleInstance: true,
    oauth:          true,
)

// ── HTTP endpoints exposed to the bridge server ───────────────────────────────

mappings {
    path("/ring/event") {
        action: [POST: "handleRingEvent"]
    }
}

// ── Preferences / setup pages ─────────────────────────────────────────────────

preferences {
    page(name: "mainPage")
    page(name: "discoveryPage")
}

def mainPage() {
    if (!state.accessToken) createAccessToken()

    dynamicPage(name: "mainPage", title: "Ring Integration", install: true, uninstall: true) {

        section("Bridge Server") {
            input "bridgeIp",   "text",   title: "Bridge IP Address", required: true
            input "bridgePort", "number", title: "Bridge Port",        required: true, defaultValue: 3000
        }

        section("Bridge Configuration") {
            paragraph """<b>Add these two lines to your bridge <code>.env</code> file:</b><br><br>
<code>HUBITAT_EVENT_URL=${getFullLocalApiServerUrl()}/ring/event</code><br>
<code>HUBITAT_ACCESS_TOKEN=${state.accessToken}</code>"""
        }

        section("Device Discovery") {
            input "includeTypes", "enum",
                title:        "Device types to import from Ring",
                options:      [
                    "cameras":        "Cameras & Doorbells",
                    "contact-sensor": "Contact Sensors",
                    "motion-sensor":  "Motion Sensors",
                    "alarm":          "Alarm",
                    "lock":           "Door Locks",
                    "light":          "Smart Lights (Ring Bridge)",
                ],
                multiple:     true,
                required:     false
            href "discoveryPage",
                 title:       "Discover Ring Devices",
                 description: "Tap to connect to the bridge and create Hubitat devices"
        }

        if (getChildDevices()) {
            section("Managed Devices (${getChildDevices().size()})") {
                getChildDevices().each { dev ->
                    paragraph "${dev.label ?: dev.name}  —  ${dev.deviceNetworkId}"
                }
            }
        }
    }
}

def discoveryPage() {
    def result = discoverRingDevices()

    dynamicPage(name: "discoveryPage", title: "Device Discovery", nextPage: "mainPage") {
        if (result.error) {
            section { paragraph "Error: ${result.error}" }
        } else {
            section("Found ${result.added} new device(s), ${result.existing} already existed") {
                paragraph result.summary ?: "No supported Ring devices found."
            }
        }
    }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

def installed() {
    if (!state.accessToken) createAccessToken()
    log.info "Ring Integration installed"
}

def updated() {
    log.info "Ring Integration updated"
    pruneDeselectedDevices()
}

def uninstalled() {
    getChildDevices().each { deleteChildDevice(it.deviceNetworkId) }
    log.info "Ring Integration uninstalled — all child devices removed"
}

// ── Inbound event handler (bridge → Hubitat) ──────────────────────────────────

def handleRingEvent() {
    def data     = request.JSON
    def deviceId = data?.deviceId?.toString()
    def type     = data?.type?.toString()
    def value    = data?.value?.toString()
    def lastUser = data?.lastUser?.toString()

    if (!deviceId || !type || !value) {
        log.warn "Ring event missing required fields: ${data}"
        render status: 400, contentType: "application/json", data: '{"error":"missing fields"}'
        return
    }

    def child = getChildDevice(deviceId)
    if (!child) {
        log.warn "No child device for Ring ID: ${deviceId}"
        render status: 404, contentType: "application/json", data: '{"error":"device not found"}'
        return
    }

    switch (type) {
        case "motion":
            child.sendEvent(name: "motion", value: value)
            break
        case "ding":
            child.sendEvent(name: "pushed", value: "1", isStateChange: true)
            break
        case "contact":
            child.sendEvent(name: "contact", value: value)
            break
        case "alarm":
            child.sendEvent(name: "securityKeypad", value: value)
            if (lastUser) child.sendEvent(name: "lastUser", value: lastUser)
            break
        case "lock":
            child.sendEvent(name: "lock", value: value)
            if (lastUser) child.sendEvent(name: "lastUser", value: lastUser)
            break
        case "switch":
            child.sendEvent(name: "switch", value: value)
            break
        case "level":
            child.sendEvent(name: "level", value: value.toInteger())
            break
        default:
            log.warn "Unknown Ring event type: ${type}"
    }

    if (type != "ding") {
        child.sendEvent(name: "lastEvent", value: "${type}=${value}${lastUser ? ' (' + lastUser + ')' : ''}")
    }

    render status: 200, contentType: "application/json", data: '{"ok":true}'
}

// ── Outbound command helper (Hubitat drivers → bridge) ────────────────────────

def sendBridgeCommand(String deviceId, String command, Map body = [:]) {
    def params = [
        uri:         "http://${settings.bridgeIp}:${settings.bridgePort}/devices/${deviceId}/${command}",
        contentType: "application/json",
        body:        groovy.json.JsonOutput.toJson(body),
        timeout:     10,
    ]
    asynchttpPost("bridgeCommandCallback", params, [deviceId: deviceId, command: command])
}

def bridgeCommandCallback(response, data) {
    if (response.status != 200) {
        log.warn "Bridge command ${data.command} for ${data.deviceId} returned ${response.status}"
    }
}

// ── Device discovery ──────────────────────────────────────────────────────────

private Map discoverRingDevices() {
    if (!settings.bridgeIp || !settings.bridgePort) {
        return [error: "Bridge IP and port must be configured first"]
    }

    def devices
    try {
        httpGet([
            uri:         "http://${settings.bridgeIp}:${settings.bridgePort}/devices",
            contentType: "application/json",
            timeout:     15,
        ]) { resp ->
            devices = resp.data
        }
    } catch (e) {
        log.error "Failed to reach bridge at ${settings.bridgeIp}:${settings.bridgePort} — ${e}"
        return [error: "Could not connect to bridge: ${e.message}"]
    }

    if (!devices) return [error: "Bridge returned empty device list"]

    def selectedTypes = settings.includeTypes ?: ["cameras", "contact-sensor", "motion-sensor", "alarm", "lock", "light"]
    if (!state.deviceTypes) state.deviceTypes = [:]

    int added = 0, existing = 0
    def lines = []

    devices.each { device ->
        def dni      = device.id?.toString()
        def name     = device.name?.toString()
        def type     = device.type?.toString()
        def driver   = driverForType(type)

        if (!dni || !name || !driver) {
            log.debug "Skipping unsupported device type: ${type}"
            return
        }

        // cameras and doorbells share the "cameras" selection key
        def typeKey = (type == "camera" || type == "doorbell") ? "cameras" : type

        // Always record the type so pruning works even for pre-existing devices
        state.deviceTypes[dni] = typeKey

        if (!selectedTypes.contains(typeKey)) {
            log.debug "Skipping device type not selected for import: ${type}"
            return
        }

        if (getChildDevice(dni)) {
            existing++
            lines << "  (exists) ${name}"
            return
        }

        try {
            addChildDevice("hubitat_ring", driver, dni, [name: name, label: name])
            added++
            lines << "  (added)  ${name}  [${driver}]"
            log.info "Created child device: ${name} → ${driver} (DNI: ${dni})"
        } catch (e) {
            log.error "Failed to create device '${name}': ${e}"
            lines << "  (error)  ${name}: ${e.message}"
        }
    }

    return [added: added, existing: existing, summary: lines.join("\n")]
}

private String driverForType(String type) {
    switch (type) {
        case "camera":         return "Ring Motion Camera"
        case "doorbell":       return "Ring Motion Camera"
        case "contact-sensor": return "Ring Contact Sensor"
        case "motion-sensor":  return "Ring Motion Sensor"
        case "alarm":          return "Ring Alarm Controller"
        case "lock":           return "Ring Lock"
        case "light":          return "Ring Smart Light"
        default:               return null
    }
}

// Infer the selection-key from a driver name — fallback for devices created
// before state.deviceTypes was introduced.
private String typeKeyFromDriver(String driverName) {
    switch (driverName) {
        case "Ring Motion Camera":    return "cameras"
        case "Ring Contact Sensor":   return "contact-sensor"
        case "Ring Motion Sensor":    return "motion-sensor"
        case "Ring Alarm Controller": return "alarm"
        case "Ring Lock":             return "lock"
        case "Ring Smart Light":      return "light"
        default:                      return null
    }
}

private void pruneDeselectedDevices() {
    def selectedTypes = settings.includeTypes ?: ["cameras", "contact-sensor", "motion-sensor", "alarm", "lock", "light"]
    def typeMap = state.deviceTypes ?: [:]

    getChildDevices().each { dev ->
        def typeKey = typeMap[dev.deviceNetworkId] ?: typeKeyFromDriver(dev.typeName)
        if (typeKey && !selectedTypes.contains(typeKey)) {
            log.info "Removing '${dev.label ?: dev.name}' — type '${typeKey}' no longer selected"
            deleteChildDevice(dev.deviceNetworkId)
        }
    }
}
