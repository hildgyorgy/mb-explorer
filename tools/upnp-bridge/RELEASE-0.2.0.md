# MusicBrainz Explorer Bridge 0.2.0

The first public Mac release of the UPnP Bridge. The DMG contains the Bridge menu-bar app and a current copy of MusicBrainz Explorer that opens locally for straightforward UPnP playback.

## Requirements

- Mac with Apple silicon and macOS 13 or later
- Navidrome and a UPnP renderer reachable on the home network

## Install and play

1. Download the `MusicBrainz-Explorer-Bridge-0.2.0-macOS-arm64.dmg` asset below.
2. Open it and drag **MusicBrainz Explorer Bridge** to **Applications**.
3. Start the app and allow local-network access if macOS asks.
4. Use the menu-bar icon's **Open MB Explorer locally (easy UPnP playback)** command.
5. Connect Navidrome in Explorer, then choose **UPnP renderer** and discover your player.

The app searches the local network automatically, including a deeper search when multicast discovery misses a renderer. Its menu shows the detected renderer's name and IP address. A manual renderer IP option is available if discovery still misses it.

The local Explorer and Bridge use `http://127.0.0.1:9181`, so this setup does not need Tailscale for browser-to-Bridge control. The published HTTPS Explorer remains available separately and needs an HTTPS Bridge URL for UPnP control in Safari. For direct audio delivery, configure Navidrome's **Home network URL for UPnP** in Explorer.
