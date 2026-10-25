# MusicBrainz Explorer UPnP bridge

A small local helper connecting the MusicBrainz Explorer web app to UPnP
MediaRenderers. It discovers renderers with SSDP, sends AVTransport commands,
and exposes short-lived local proxy URLs so a renderer can play a Navidrome
stream even when it cannot reach the browser's Navidrome URL directly.

The same bridge service supports two installations: a native macOS menu-bar
app on the browsing Mac, or an always-on Docker service on the Navidrome/UPnP
home network. The browser-control API accepts requests only through loopback
and only from the published Explorer origin or a localhost development origin.
Network devices can access only unguessable audio-proxy URLs created for the
active queue.

## macOS user instructions

1. Open `MusicBrainz-Explorer-Bridge-…-macOS-….dmg`.
2. Drag **MusicBrainz Explorer Bridge** into **Applications**.
3. Start it. On first launch, allow local-network access when macOS asks.
4. A speaker icon appears in the menu bar. It should say **Bridge running**.
5. In the Explorer's Navidrome settings, optionally enter the server's
   **Home network URL for UPnP** (for example `http://192.168.1.10:4533`).
6. Open MusicBrainz Explorer, choose **Output → UPnP renderer**, then select
   **Discover UPnP renderers**.
7. Select the renderer and play a Navidrome-backed release.

The Mac, renderer and Navidrome server must be reachable on the relevant local
network. With a Home network URL the renderer fetches audio directly from
Navidrome; otherwise the bridge relays it. The Mac must remain awake while the renderer is playing. The menu-bar
item can open the Explorer, show the diagnostic log, restart the bridge or quit.

The local test DMG is ad-hoc signed. A public download must instead be signed
with a **Developer ID Application** certificate, submitted with `notarytool`,
and stapled before release.

## Run from source

```sh
python3 musicards_upnp_bridge.py
```

Environment variables:

- `MUSICARDS_BRIDGE_HOST` — listener address, default `0.0.0.0` because a
  renderer must fetch proxied audio from the bridge.
- `MUSICARDS_BRIDGE_PORT` — HTTP port, default `9181`.
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

## Docker / Linux

Docker is the preferred always-on installation for Linux, Raspberry Pi and
Umbrel. SSDP requires host networking:

```sh
docker compose up -d --build
```

The same bridge API is served on port `9181`.

### Umbrel with Tailscale Serve

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
