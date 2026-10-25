import AppKit
import Foundation

final class BridgeAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var statusMenuItem: NSMenuItem!
    private var bridgeProcess: Process?
    private var logHandle: FileHandle?
    private var healthTimer: Timer?

    private var logURL: URL {
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        return library.appendingPathComponent("Logs/MusicBrainz Explorer Bridge.log")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "hifispeaker.2", accessibilityDescription: "MusicBrainz Explorer Bridge")
            button.toolTip = "MusicBrainz Explorer Bridge"
        }

        let menu = NSMenu()
        statusMenuItem = NSMenuItem(title: "Bridge starting…", action: nil, keyEquivalent: "")
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open MusicBrainz Explorer", action: #selector(openExplorer), keyEquivalent: "")
        menu.addItem(withTitle: "Show Log", action: #selector(showLog), keyEquivalent: "")
        menu.addItem(withTitle: "Restart Bridge", action: #selector(restartBridge), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items where item.action != nil { item.target = self }
        statusItem.menu = menu

        startBridge()
        healthTimer = Timer.scheduledTimer(timeInterval: 2, target: self,
                                           selector: #selector(checkHealth),
                                           userInfo: nil, repeats: true)
        checkHealth()
    }

    private func startBridge() {
        guard bridgeProcess?.isRunning != true else { return }
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
            process.environment = environment
            process.standardOutput = logHandle
            process.standardError = logHandle
            process.terminationHandler = { [weak self] _ in
                DispatchQueue.main.async {
                    self?.bridgeProcess = nil
                    self?.statusMenuItem.title = "Bridge stopped"
                    self?.checkHealth()
                }
            }
            try process.run()
            bridgeProcess = process
            statusMenuItem.title = "Bridge starting…"
        } catch {
            statusMenuItem.title = "Bridge could not start"
            appendLog("Launcher error: \(error.localizedDescription)\n")
        }
    }

    private func stopBridge() {
        if bridgeProcess?.isRunning == true { bridgeProcess?.terminate() }
        bridgeProcess = nil
        try? logHandle?.close()
        logHandle = nil
    }

    private func appendLog(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        try? logHandle?.write(contentsOf: data)
    }

    @objc private func checkHealth() {
        guard let url = URL(string: "http://127.0.0.1:9181/health") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let healthy = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                self?.statusMenuItem.title = healthy ? "Bridge running" : "Bridge unavailable"
            }
        }.resume()
    }

    @objc private func restartBridge() {
        stopBridge()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.startBridge()
            self?.checkHealth()
        }
    }

    @objc private func openExplorer() {
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
        stopBridge()
    }
}

let app = NSApplication.shared
let delegate = BridgeAppDelegate()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
