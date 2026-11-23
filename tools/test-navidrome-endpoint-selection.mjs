import assert from "node:assert/strict";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
};
globalThis.window = {
  setTimeout,
  clearTimeout,
  dispatchEvent() {},
};

const {
  connectNavidrome,
  getNavidromeAlbum,
  refreshNavidromeEndpoint,
} = await import("../assets/js/services/navidrome.js");

function ok(payload) {
  return {
    ok: true,
    async json() { return { "subsonic-response": { status: "ok", ...payload } }; },
  };
}

async function connectWith(fetchImplementation) {
  globalThis.fetch = fetchImplementation;
  return connectNavidrome({
    name: "Test Navidrome",
    serverUrl: "https://music.example.com",
    homeServerUrl: "http://server.local:4533",
    username: "listener",
    userPassword: "secret",
  });
}

{
  const requests = [];
  const result = await connectWith(async (url) => {
    requests.push(String(url));
    if (String(url).includes("/rest/ping.view")) return ok({ openSubsonic: true, type: "navidrome" });
    return ok({ albumList2: { album: [{
      id: "album-1",
      name: "Test album",
      artist: "Test artist",
      musicBrainzId: "353021d1-3d84-4f17-9fe4-66788d785a9d",
      song: [{
        id: "song-1",
        title: "Test track",
        musicBrainzId: "11111111-1111-4111-8111-111111111111",
        discNumber: 1,
        track: 1,
        suffix: "flac",
      }],
    }] } });
  });
  assert.equal(result.profile.activeEndpoint, "local");
  assert.equal(result.profile.baseUrl.hostname, "server.local");
  assert.ok(requests.every((url) => url.startsWith("http://server.local:4533/")));

  globalThis.fetch = async (url) => {
    if (String(url).startsWith("http://server.local:4533/")) throw new TypeError("Local endpoint unavailable");
    return ok({ openSubsonic: true, type: "navidrome" });
  };
  const remoteRefresh = await refreshNavidromeEndpoint();
  assert.deepEqual(remoteRefresh, { changed: true, activeEndpoint: "remote" });
  assert.ok(getNavidromeAlbum("353021d1-3d84-4f17-9fe4-66788d785a9d").tracks[0].playbackUrl.startsWith("https://music.example.com/"));

  globalThis.fetch = async () => ok({ openSubsonic: true, type: "navidrome" });
  const localRefresh = await refreshNavidromeEndpoint();
  assert.deepEqual(localRefresh, { changed: true, activeEndpoint: "local" });
  assert.ok(getNavidromeAlbum("353021d1-3d84-4f17-9fe4-66788d785a9d").tracks[0].playbackUrl.startsWith("http://server.local:4533/"));
}

{
  const requests = [];
  const result = await connectWith(async (url) => {
    const address = String(url);
    requests.push(address);
    if (address.startsWith("http://server.local:4533/")) throw new TypeError("Local endpoint unavailable");
    if (address.includes("/rest/ping.view")) return ok({ openSubsonic: true, type: "navidrome" });
    return ok({ albumList2: { album: [] } });
  });
  assert.equal(result.profile.activeEndpoint, "remote");
  assert.equal(result.profile.baseUrl.hostname, "music.example.com");
  assert.ok(requests.some((url) => url.startsWith("http://server.local:4533/")));
  assert.ok(requests.some((url) => url.startsWith("https://music.example.com/")));
}

console.log("Navidrome endpoint selection regressions passed.");
