import AppKit
import Foundation

final class BridgeAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var statusMenuItem: NSMenuItem!
    private var startMenuItem: NSMenuItem!
    private var stopMenuItem: NSMenuItem!
    private var rendererMenuItem: NSMenuItem!
    private var bridgeProcess: Process?
    private var isStopping = false
    private var restartAfterStop = false
    private var logHandle: FileHandle?
    private var healthTimer: Timer?

    private var logURL: URL {
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        return library.appendingPathComponent("Logs/MusicBrainz Explorer Bridge.log")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
               let icon = NSImage(contentsOf: iconURL) {
                icon.size = NSSize(width: 18, height: 18)
                icon.isTemplate = false
                button.image = icon
            } else {
                button.image = NSImage(systemSymbolName: "hifispeaker.2", accessibilityDescription: "MusicBrainz Explorer Bridge")
            }
            button.toolTip = "MusicBrainz Explorer Bridge"
        }

        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "Bridge starting…", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        startMenuItem = menu.addItem(withTitle: "Start UPnP Bridge", action: #selector(startBridge), keyEquivalent: "")
        stopMenuItem = menu.addItem(withTitle: "Stop UPnP Bridge", action: #selector(stopBridge), keyEquivalent: "")
        rendererMenuItem = menu.addItem(withTitle: "Renderer IP: Automatic…", action: #selector(configureRendererIP), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open MusicBrainz Explorer (Local)", action: #selector(openExplorer), keyEquivalent: "")
        menu.addItem(withTitle: "Open Published Website", action: #selector(openPublishedExplorer), keyEquivalent: "")
        menu.addItem(withTitle: "Show Log", action: #selector(showLog), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit App", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items where item.action != nil { item.target = self }
        statusItem.menu = menu

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

    private func updateRendererMenuTitle() {
        let address = UserDefaults.standard.string(forKey: "rendererIP") ?? ""
        rendererMenuItem.title = address.isEmpty ? "Renderer IP: Automatic…" : "Renderer IP: \(address)…"
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
                    try? self.logHandle?.close()
                    self.logHandle = nil
                    self.statusMenuItem.title = "Bridge stopped"
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
            updateMenuActions()
        } catch {
            statusMenuItem.title = "Bridge could not start"
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
                self.statusMenuItem.title = healthy ? "Bridge running" : "Bridge unavailable"
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
        restartAfterStop = false
        if bridgeProcess?.isRunning == true { bridgeProcess?.terminate() }
    }
}

let app = NSApplication.shared
let delegate = BridgeAppDelegate()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
