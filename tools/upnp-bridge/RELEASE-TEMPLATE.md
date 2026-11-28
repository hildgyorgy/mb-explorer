## 1. Install

Download the Apple Silicon DMG from **Assets** below. Open it, drag **MusicBrainz Explorer Bridge** to Applications, and launch it. Allow local network access if macOS asks.

## 2. Set up

- **Bundled Explorer.** Choose **Open MB Explorer locally** in the Bridge menu and use `http://127.0.0.1:9181` as the **Bridge URL**.
- **Hosted Explorer.** With the Bridge and Tailscale running on the same Mac, run this in Terminal:

  ```sh
  /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg http://127.0.0.1:9181
  ```

  Open the hosted Explorer and paste the HTTPS address printed by Serve into **Bridge URL**. Keep the browser device on the same tailnet.

In either Explorer, connect **Navidrome** under **Source**. Go to **Output → UPnP renderer**, enter the Bridge URL for your setup, choose **Discover UPnP renderers**, and select a renderer on the Mac’s local network.

## 3. Play

Open a release matched to your Navidrome library and start a playable track. Keep the Bridge running and the Mac awake. [Full Bridge setup guide and troubleshooting](https://hildgyorgy.github.io/mb-explorer/support.html#upnp-bridge).
