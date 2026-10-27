# MusicBrainz Explorer — handoff

Updated: 2026-10-27

## Repository state

- Repository: `mb-explorer`
- Branch: `main`
- Current commit: `bf707f6` (`sticky headers`)
- Remote state at handoff: `main` is aligned with `origin/main`
- Working tree was clean before this handoff file was created.
- App version: `1.5.0`
- Published app: <https://hildgyorgy.github.io/mb-explorer/>

The latest commits are:

```text
bf707f6 sticky headers
22250b4 upnp
5e3ae0c 2 column view
36253a8 Open artist albums in Versions view
8107aba Mark playable releases in Versions view
```

## Current product behavior

The web app is a framework-free MusicBrainz release viewer and player. It can
use either a browser-accessible local music folder or a Navidrome/OpenSubsonic
server as its source. Browser/system audio is the normal output; a local bridge
adds UPnP renderer control.

The start page contains only the centered blue logo. The setup panel opens from
either the logo or the header cog. Source, output and release layout can be
selected directly in the first setup panel; selecting the already-active choice
opens its detailed settings.

Release pages have two layouts:

- **Focus** is the default, traditional single-column presentation.
- **Desktop** is the optional two-column presentation. Cover/release metadata
  stay fixed, Versions scroll independently on the left, and Tracklist scrolls
  independently on the right. The player is aligned under the tracklist column.

The latest change makes both new Desktop section labels sticky:

- `VERSIONS` remains immediately below the fixed cover/metadata block.
- `TRACKLIST` remains at the top of the right-hand scroll area.
- The left offset is calculated from the real header height, so it survives
  resizing and differing release metadata heights.
- Focus and mobile layouts are unchanged.

Relevant files for that change:

- `assets/js/ui/layout.js`
- `assets/styles.css`

## Playback model — important architecture

### Sources

1. **Local**: files available to the browser on the current phone/computer,
   including a locally mounted/synchronized storage provider.
2. **Navidrome**: the same Navidrome library may be reached locally or remotely.

Navidrome has two deliberately separate addresses:

- **Remote / Tailscale URL**: HTTPS browser-facing address used for catalogue,
  matching and browser/system-audio playback from anywhere.
- **Home network URL for UPnP**: optional LAN address such as
  `http://umbrel.local:4533`. It is handed to a renderer only when the renderer,
  Navidrome and bridge are on the same LAN.

### Outputs

1. **System audio**: playback in the browser through the device's currently
   selected system output (speaker, headphones, USB DAC, etc.), locally or
   remotely wherever the source is reachable.
2. **UPnP renderer**: intended only while the renderer, Navidrome and bridge are
   reachable on the same home/office LAN. UPnP output currently requires the
   Navidrome source.

Do not conflate the two roles of Tailscale:

- Tailscale/HTTPS can expose Navidrome to the browser from anywhere.
- For an Umbrel/Raspberry Pi bridge, private Tailscale Serve also solves the
  HTTPS-page-to-bridge control connection.
- The renderer itself does **not** need Tailscale. It receives the local
  Navidrome stream URL and fetches the audio directly over the LAN.
- If no Home network URL is configured, the bridge can relay the stream through
  a short-lived unguessable proxy URL.

This mirrors the native iOS/macOS MusiCards app's two-address model. MusiCards
does not need the browser bridge because the native app can control UPnP itself.

## UPnP bridge

Source: `tools/upnp-bridge/`

Supported installation targets:

- Native macOS menu-bar helper on port `9181`.
- Docker/Linux/Raspberry Pi/Umbrel service using host networking for SSDP.

Browser Bridge URL examples:

- Mac helper: `http://127.0.0.1:9181`
- Umbrel: the private `https://…ts.net` URL created by Tailscale Serve

Main files:

- `tools/upnp-bridge/musicards_upnp_bridge.py` — discovery, control and relay
- `tools/upnp-bridge/docker-compose.yml` and `Dockerfile` — Linux/Umbrel
- `tools/upnp-bridge/macos/main.swift` — menu-bar wrapper
- `tools/upnp-bridge/macos/build_macos.sh` — local DMG build
- `tools/upnp-bridge/README.md` — install/run instructions

The macOS test DMG is ad-hoc signed. Public distribution still needs Developer
ID signing, notarization and stapling. Build output is intentionally ignored by
Git and lives under `tools/upnp-bridge/dist/` when present.

### Next real-world verification

The code is prepared but UPnP needs testing at the office with the AVM AUDIO CS
2.3. Test both bridge placements if practical:

1. Always-on Raspberry Pi 5 / Umbrel bridge, controlled through private
   Tailscale Serve, with the renderer streaming directly from the Navidrome Home
   network URL.
2. Native M1 Mac mini bridge at `http://127.0.0.1:9181`.

Check discovery, renderer persistence by UDN, play/pause, next-track queueing,
seek/state polling, disconnect/reconnect and browser restart persistence. Also
confirm that system-audio playback still uses the Remote/Tailscale Navidrome URL.

## Matching and playability rules

- Local and Navidrome tracks are matched safely using MusicBrainz identifiers.
- Exact release-track MBID is preferred.
- Recording MBID fallback is allowed only when release-track data is absent and
  the candidate is unambiguous by medium/disc and track position.
- This avoids marking both CD and hi-res layers of a hybrid SACD playable when
  only one layer exists locally.
- Versions cards show a circular play marker when that exact release is
  playable.
- Artist discography entries show a marker when at least one version of that
  release group is playable; selecting an album opens its Versions view.

## Local library indexing

- Browser indexer and `generate_library.py` produce index format version 2.
- `library.json` and `library-report.json` belong in the selected Music root.
- After using the Python indexer, the user must still choose **Connect Music
  Folder** so the browser receives access to the files and reads the index.
- Reports use embedded Album Artist/Album tags for untagged entries; folder names
  are not treated as album identities.
- Persistent directory handles are restored where supported, although the
  browser may request permission again.

## Running locally

There is no build step. Serve the repository as static files, for example:

```sh
python3 -m http.server 9187 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:9187/
```

A useful release for layout checks is Miles Davis — *Kind of Blue*:

```text
http://127.0.0.1:9187/?mbid=353021d1-3d84-4f17-9fe4-66788d785a9d
```

## Verification commands

Run from the repository root:

```sh
node --check assets/js/ui/layout.js
node --check assets/js/ui/releaseLayout.js
node tools/test-upnp-renderer-config.mjs
node tools/test-navidrome-matching.mjs
node tools/test-local-library-report.mjs
git diff --check
```

These checks passed after the sticky-header implementation.

## Notes for the next session

- Inspect `git status --short --branch` first. This handoff file itself is the
  only expected new uncommitted file at creation time.
- Keep Focus as the default release layout.
- Preserve the clean/minimal visual language and the existing setup hierarchy.
- Do not remove the native Mac bridge even if Umbrel becomes the preferred
  installation; both are intentional supported paths.
- The support page still describes UPnP as planned/under development in places.
  After successful hardware testing, update `README.md`, `support.html` and the
  version/release notes together to describe it as supported.
