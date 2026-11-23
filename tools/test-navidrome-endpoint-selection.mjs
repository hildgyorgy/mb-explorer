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

const { connectNavidrome } = await import("../assets/js/services/navidrome.js");

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
    return ok({ albumList2: { album: [] } });
  });
  assert.equal(result.profile.activeEndpoint, "local");
  assert.equal(result.profile.baseUrl.hostname, "server.local");
  assert.ok(requests.every((url) => url.startsWith("http://server.local:4533/")));
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
