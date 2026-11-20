import AppKit
import Foundation

private struct RendererList: Decodable {
    struct Renderer: Decodable {
        let friendlyName: String
        let address: String
    }
    let renderers: [Renderer]
}

final class BridgeAppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var statusMenuItem: NSMenuItem!
    private var startMenuItem: NSMenuItem!
    private var stopMenuItem: NSMenuItem!
    private var detectedHeading: NSMenuItem!
    private var detectedRows: [NSMenuItem] = []
    private var rendererMenuItem: NSMenuItem!
    private var bridgeProcess: Process?
    private var isStopping = false
    private var restartAfterStop = false
    private var logHandle: FileHandle?
    private var healthTimer: Timer?
    private var rendererTask: URLSessionDataTask?
    private var rendererGeneration = 0
    private var idleIcon: NSImage?
    private var runningIcon: NSImage?

    private var logURL: URL {
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        return library.appendingPathComponent("Logs/MusicBrainz Explorer Bridge.log")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        configureStatusIcon()

        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "Bridge starting…", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        startMenuItem = menu.addItem(withTitle: "Start UPnP Bridge", action: #selector(startBridge), keyEquivalent: "")
        stopMenuItem = menu.addItem(withTitle: "Stop UPnP Bridge", action: #selector(stopBridge), keyEquivalent: "")
        menu.addItem(.separator())
        detectedHeading = NSMenuItem(title: "Detected renderers", action: nil, keyEquivalent: "")
        detectedHeading.isEnabled = false
        menu.addItem(detectedHeading)
        rendererMenuItem = menu.addItem(withTitle: "Renderer IP: Automatic…", action: #selector(configureRendererIP), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open MB Explorer online (UPnP via Tailscale)", action: #selector(openPublishedExplorer), keyEquivalent: "")
        menu.addItem(withTitle: "Open MB Explorer locally (easy UPnP playback)", action: #selector(openExplorer), keyEquivalent: "")
        menu.addItem(withTitle: "Show Log", action: #selector(showLog), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit App", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items where item.action != nil { item.target = self }
        statusItem.menu = menu
        menu.delegate = self
        showRendererRows(["Searching for renderers…"])

        updateRendererMenuTitle()
        updateMenuActions()
        startBridge()
        healthTimer = Timer.scheduledTimer(timeInterval: 2, target: self,
                                           selector: #selector(checkHealth),
                                           userInfo: nil, repeats: true)
        checkHealth()
    }

    private func updateMenuActions() {
        let running = bridgeProcess?.isRunning == true
        startMenuItem.isEnabled = bridgeProcess == nil && !isStopping
        stopMenuItem.isEnabled = running && !isStopping
    }

    private func configureStatusIcon() {
        guard let button = statusItem.button else { return }
        button.toolTip = "MusicBrainz Explorer Bridge"
        guard let iconURL = Bundle.main.url(forResource: "icon", withExtension: "png", subdirectory: "site"),
              let source = NSImage(contentsOf: iconURL) else {
            let fallback = NSImage(systemSymbolName: "hifispeaker.2", accessibilityDescription: "MusicBrainz Explorer Bridge")
            fallback?.isTemplate = true
            button.image = fallback
            return
        }

        let size = NSSize(width: 22, height: 22)
        let sourceRect = NSRect(x: 159, y: 112, width: 706, height: 800)
        let destination = NSRect(x: 3.3, y: 2.25, width: 15.4, height: 17.5)
        func makeIcon(color: NSColor?, isTemplate: Bool) -> NSImage {
            let image = NSImage(size: size)
            image.lockFocus()
            source.draw(in: destination, from: sourceRect, operation: .sourceOver, fraction: 1)
            if let color = color {
                color.setFill()
                NSRect(origin: .zero, size: size).fill(using: .sourceIn)
            }
            image.unlockFocus()
            image.isTemplate = isTemplate
            return image
        }
        idleIcon = makeIcon(color: nil, isTemplate: true)
        runningIcon = makeIcon(color: .systemBlue, isTemplate: false)
        button.image = idleIcon
    }

    private func updateStatusIcon(running: Bool) {
        statusItem.button?.image = running ? (runningIcon ?? idleIcon) : idleIcon
    }

    private func updateRendererMenuTitle() {
        let address = UserDefaults.standard.string(forKey: "rendererIP") ?? ""
        rendererMenuItem.title = address.isEmpty ? "Renderer IP: Automatic…" : "Renderer IP: \(address)…"
    }

    private func showRendererRows(_ titles: [String]) {
        guard let menu = statusItem?.menu, let heading = detectedHeading else { return }
        for item in detectedRows { menu.removeItem(item) }
        detectedRows.removeAll()
        let headingIndex = menu.index(of: heading)
        guard headingIndex >= 0 else { return }
        for (offset, title) in titles.enumerated() {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.insertItem(item, at: headingIndex + 1 + offset)
            detectedRows.append(item)
        }
    }

    private func refreshRenderers() {
        guard rendererTask == nil, let process = bridgeProcess,
              process.isRunning, !isStopping,
              let url = URL(string: "http://127.0.0.1:9181/renderers") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        let generation = rendererGeneration
        let task = URLSession.shared.dataTask(with: request) { [weak self, weak process] data, response, _ in
            DispatchQueue.main.async {
                guard let self = self, self.rendererGeneration == generation else { return }
                self.rendererTask = nil
                guard let process = process, self.bridgeProcess === process,
                      !self.isStopping else { return }
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let data = data,
                      let list = try? JSONDecoder().decode(RendererList.self, from: data) else {
                    self.showRendererRows(["Renderer search unavailable"])
                    return
                }
                let renderers = list.renderers.sorted {
                    $0.friendlyName.localizedStandardCompare($1.friendlyName) == .orderedAscending
                }
                let titles = renderers.map { renderer in
                    let name = renderer.friendlyName.isEmpty ? "UPnP renderer" : renderer.friendlyName
                    return renderer.address.isEmpty ? name : "\(name) — \(renderer.address)"
                }
                self.showRendererRows(titles.isEmpty ? ["No UPnP renderer found"] : titles)
            }
        }
        rendererTask = task
        task.resume()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshRenderers()
    }

    private func validRendererIP(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { UInt8($0) }
        guard octets.count == 4 else { return false }
        return octets[0] == 10 ||
            (octets[0] == 172 && (16...31).contains(Int(octets[1]))) ||
            (octets[0] == 192 && octets[1] == 168)
    }

    @objc private func configureRendererIP() {
        let alert = NSAlert()
        alert.messageText = "Renderer IP address"
        alert.informativeText = "Enter the renderer's local IPv4 address if automatic discovery does not find it. Leave blank for automatic discovery."
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        input.stringValue = UserDefaults.standard.string(forKey: "rendererIP") ?? ""
        input.placeholderString = "192.168.1.50"
        alert.accessoryView = input
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let address = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard address.isEmpty || validRendererIP(address) else {
            let error = NSAlert()
            error.messageText = "Enter a private IPv4 address"
            error.informativeText = "Use the renderer's local 10.x.x.x, 172.16–31.x.x, or 192.168.x.x address."
            error.runModal()
            return
        }
        if address.isEmpty { UserDefaults.standard.removeObject(forKey: "rendererIP") }
        else { UserDefaults.standard.set(address, forKey: "rendererIP") }
        updateRendererMenuTitle()
        if bridgeProcess?.isRunning == true {
            restartAfterStop = true
            stopBridge()
        }
    }

    @objc private func startBridge() {
        guard bridgeProcess == nil && !isStopping else { return }
        guard let resources = Bundle.main.resourceURL else {
            statusMenuItem.title = "Bridge resources missing"
            return
        }
        let executable = resources.appendingPathComponent("bridge/MusicBrainzExplorerBridgeService")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            statusMenuItem.title = "Bridge service missing"
            return
        }

        do {
            try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            logHandle = try FileHandle(forWritingTo: logURL)
            try logHandle?.seekToEnd()

            let process = Process()
            process.executableURL = executable
            process.currentDirectoryURL = executable.deletingLastPathComponent()
            var environment = ProcessInfo.processInfo.environment
            environment["MUSICARDS_BRIDGE_HOST"] = "0.0.0.0"
            environment["MUSICARDS_BRIDGE_PORT"] = "9181"
            environment["MUSICARDS_BRIDGE_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
            environment["MUSICARDS_RENDERER_IP"] = UserDefaults.standard.string(forKey: "rendererIP") ?? ""
            process.environment = environment
            process.standardOutput = logHandle
            process.standardError = logHandle
            process.terminationHandler = { [weak self, weak process] _ in
                DispatchQueue.main.async {
                    guard let self = self, let process = process,
                          self.bridgeProcess === process else { return }
                    self.bridgeProcess = nil
                    self.isStopping = false
                    self.rendererGeneration += 1
                    self.rendererTask?.cancel()
                    self.rendererTask = nil
                    try? self.logHandle?.close()
                    self.logHandle = nil
                    self.statusMenuItem.title = "Bridge stopped"
                    self.updateStatusIcon(running: false)
                    self.showRendererRows(["Bridge stopped"])
                    self.updateMenuActions()
                    if self.restartAfterStop {
                        self.restartAfterStop = false
                        self.startBridge()
                    }
                }
            }
            try process.run()
            bridgeProcess = process
            statusMenuItem.title = "Bridge starting…"
            updateStatusIcon(running: false)
            showRendererRows(["Searching for renderers…"])
            updateMenuActions()
        } catch {
            statusMenuItem.title = "Bridge could not start"
            updateStatusIcon(running: false)
            appendLog("Launcher error: \(error.localizedDescription)\n")
            try? logHandle?.close()
            logHandle = nil
            updateMenuActions()
        }
    }

    @objc private func stopBridge() {
        guard let process = bridgeProcess, process.isRunning, !isStopping else { return }
        isStopping = true
        statusMenuItem.title = "Bridge stopping…"
        updateStatusIcon(running: false)
        rendererGeneration += 1
        rendererTask?.cancel()
        rendererTask = nil
        showRendererRows(["Bridge stopped"])
        updateMenuActions()
        process.terminate()
    }

    private func appendLog(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        try? logHandle?.write(contentsOf: data)
    }

    @objc private func checkHealth() {
        guard let process = bridgeProcess, process.isRunning, !isStopping else { return }
        guard let url = URL(string: "http://127.0.0.1:9181/health") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let healthy = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                guard let self = self, self.bridgeProcess === process, !self.isStopping else { return }
                let wasHealthy = self.statusMenuItem.title == "Bridge running"
                self.statusMenuItem.title = healthy ? "Bridge running" : "Bridge unavailable"
                self.updateStatusIcon(running: healthy)
                if healthy && !wasHealthy { self.refreshRenderers() }
            }
        }.resume()
    }

    @objc private func openExplorer() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:9181/")!)
    }

    @objc private func openPublishedExplorer() {
        NSWorkspace.shared.open(URL(string: "https://hildgyorgy.github.io/mb-explorer/")!)
    }

    @objc private func showLog() {
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        NSWorkspace.shared.open(logURL)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        healthTimer?.invalidate()
        rendererTask?.cancel()
        restartAfterStop = false
        if bridgeProcess?.isRunning == true { bridgeProcess?.terminate() }
    }
}

let app = NSApplication.shared
let delegate = BridgeAppDelegate()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
