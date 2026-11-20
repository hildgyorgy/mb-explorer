# MusicBrainz Explorer UPnP bridge

A small local helper connecting the MusicBrainz Explorer web app to UPnP
MediaRenderers. It discovers renderers with SSDP, sends AVTransport commands,
and exposes short-lived local proxy URLs so a renderer can play a Navidrome
stream even when it cannot reach the browser's Navidrome URL directly.

The published download is a native macOS menu-bar app. This repository also
contains Docker source files for people building their own deployment; no
prebuilt Docker image or Umbrel package is currently released. The
browser-control API accepts requests only through loopback
and only from the published Explorer origin or a localhost development origin.
Network devices can access only unguessable audio-proxy URLs created for the
active queue.

## macOS user instructions

Download the Apple Silicon Mac app from the
[Bridge 0.2.0 release page](https://github.com/hildgyorgy/mb-explorer/releases/tag/bridge-v0.2.0).

1. Open `MusicBrainz-Explorer-Bridge-…-macOS-….dmg`.
2. Drag **MusicBrainz Explorer Bridge** into **Applications**.
3. Start it. On first launch, allow local-network access when macOS asks.
4. The app starts the bridge and shows its logo in the menu bar. The icon is
   blue while the bridge is running and uses the system menu-bar color when
   stopped. Choose **Open MB Explorer locally (easy UPnP playback)** to open
   its bundled webapp at
   `http://127.0.0.1:9181/`. This local webapp talks to the bridge at the
   same address, so Safari does not need Tailscale Serve for bridge control.
   The menu also shows **Bridge running**, stop or start the bridge, or quit.
   Under **Detected renderers**, it shows each discovered device's name and
   local IP address. Opening the menu refreshes this list in the background.
   Discovery first uses multicast SSDP, then a bounded local-network deep
   search if needed. If both miss a renderer, choose **Renderer IP** and enter
   its local address; the bridge restarts with direct discovery enabled.
5. In the Explorer's Navidrome settings, optionally enter the server's
   **Home network URL for UPnP** (for example `http://192.168.1.10:4533`).
6. In the local MusicBrainz Explorer, choose **Output → UPnP renderer**, then select
   **Discover UPnP renderers**.
7. Select the renderer and play a Navidrome-backed release.

The Mac, renderer and Navidrome server must be reachable on the relevant local
network. With a Home network URL the renderer fetches audio directly from
Navidrome; otherwise the bridge relays it. The Mac must remain awake while the renderer is playing. The menu-bar
item can open the Explorer, show the diagnostic log, stop or start the bridge,
or quit the app.

The public 0.2.0 DMG is signed with a **Developer ID Application** certificate,
notarized by Apple, and stapled. Running the build script without
`CODESIGN_IDENTITY` creates an ad-hoc signed DMG for local testing only.

## Run from source

```sh
python3 musicards_upnp_bridge.py
```

When running from this repository, open `http://127.0.0.1:9181/` for the local
webapp. The packaged Mac app includes a copy of the webapp; update the app to
receive later website changes. The local and published websites have separate
browser storage, so connect Navidrome once in the local copy.

If multicast discovery does not find a known renderer, supply its local IP for
direct SSDP discovery as well:

```sh
MUSICARDS_RENDERER_IP=192.168.1.50 python3 musicards_upnp_bridge.py
```

The startup message shows `http://localhost:9181` for the default bind address.
`0.0.0.0` means the bridge listens on all network interfaces; it is not a URL
to enter in a browser or the Explorer's Bridge URL field.

Environment variables:

- `MUSICARDS_BRIDGE_HOST` — listener address, default `0.0.0.0` because a
  renderer must fetch proxied audio from the bridge.
- `MUSICARDS_BRIDGE_PORT` — HTTP port, default `9181`.
- `MUSICARDS_RENDERER_IP` — optional private IPv4 address for direct renderer
  discovery alongside multicast.
- `MUSICARDS_ALLOWED_ORIGINS` — additional comma-separated browser origins.

## Build the macOS DMG

The build requires macOS, Xcode command-line tools and Python 3. It creates an
isolated build environment and installs PyInstaller there.

```sh
chmod +x macos/build_macos.sh macos/notarize_macos.sh
macos/build_macos.sh
```

Output is written to `dist/`. The current machine builds its native
architecture. Build arm64 and x86_64 artifacts on matching Python installations
or use a universal2 Python distribution for a universal app.

For a public Developer ID build:

```sh
CODESIGN_IDENTITY="Developer ID Application: …" macos/build_macos.sh
macos/notarize_macos.sh dist/MusicBrainz-Explorer-Bridge-…dmg NOTARY_PROFILE
```

Store notarization credentials once with `xcrun notarytool store-credentials`;
never place them in the repository or build script.

## Docker / Linux: build from source

This is a source-build example, not a downloadable Bridge release. A custom
always-on Docker deployment on Linux, Raspberry Pi or Umbrel requires host
networking for SSDP:

```sh
docker compose up -d --build
```

The same bridge API is served on port `9181`.

Safari may block `http://localhost:9181` from the published Explorer HTTPS page
as mixed content. Opening the bundled local webapp from the Bridge app avoids
that conflict. To keep using the published HTTPS page, a Mac running Tailscale
can use `tailscale serve --bg 9181` for a private HTTPS Bridge URL.

### Custom Umbrel deployment with Tailscale Serve

The Explorer is an HTTPS page, so it cannot reliably call a plain HTTP service
at `umbrel.local`. Keep the bridge private and put Tailscale Serve in front of
its loopback endpoint on the Umbrel host:

```sh
tailscale serve --bg 9181
tailscale serve status
```

Enter the resulting `https://…ts.net` address as **Bridge URL** in the
Explorer's UPnP output settings. Tailscale is used only for browser-to-bridge
control. The bridge discovers and controls the renderer on the LAN, and the
renderer fetches audio directly from the Navidrome **Home network URL** such as
`http://umbrel.local:4533`.

The browsing phone or computer must be connected to the same tailnet as the
Umbrel. Do not use Tailscale Funnel: the bridge is intended to remain private.
