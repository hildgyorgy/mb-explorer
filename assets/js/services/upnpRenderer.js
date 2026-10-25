const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";

let renderer = null;
let discoveredRenderers = [];
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:9181";
const BRIDGE_URL_KEY = "musicbrainz-explorer.upnp.bridge-url";
const RENDERER_KEY = "musicbrainz-explorer.upnp.renderer";

function storageGet(key) {
  try { return localStorage.getItem(key); } catch (error) { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch (error) { /* storage may be unavailable */ }
}

function storageRemove(key) {
  try { localStorage.removeItem(key); } catch (error) { /* storage may be unavailable */ }
}

export function normalizeBridgeUrl(value) {
  const text = String(value || "").trim() || DEFAULT_BRIDGE_URL;
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("Enter a complete HTTP(S) bridge address without credentials or query parameters.");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol === "http:" && !loopback && globalThis.location?.protocol === "https:") {
    throw new Error("This HTTPS page needs an HTTPS bridge address. Use Tailscale Serve for an Umbrel bridge.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function getBridgeUrl() {
  try { return normalizeBridgeUrl(storageGet(BRIDGE_URL_KEY) || DEFAULT_BRIDGE_URL); }
  catch (error) { return DEFAULT_BRIDGE_URL; }
}

export function setBridgeUrl(value) {
  const next = normalizeBridgeUrl(value);
  if (next !== getBridgeUrl()) {
    renderer = null;
    storageRemove(RENDERER_KEY);
    window.dispatchEvent(new CustomEvent("playback-output-change"));
  }
  storageSet(BRIDGE_URL_KEY, next);
  return next;
}

export function getSavedRendererPreference() {
  try {
    const saved = JSON.parse(storageGet(RENDERER_KEY) || "null");
    return saved?.id && saved?.bridgeUrl ? saved : null;
  } catch (error) { return null; }
}

function localName(tag) {
  return String(tag || "").split("}").pop();
}

async function xml(url) {
  const response = await fetch(url, { headers: { Accept: "application/xml, text/xml" } });
  if (!response.ok) throw new Error(`Renderer description returned HTTP ${response.status}.`);
  return new DOMParser().parseFromString(await response.text(), "application/xml");
}

export async function loadRendererDescription(descriptionUrl) {
  const raw = String(descriptionUrl || "").trim();
  if (!/^https?:\/\//i.test(raw)) throw new Error("Enter the complete HTTP(S) device description URL.");
  const url = new URL(raw);
  const document = await xml(url);
  const services = [...document.getElementsByTagNameNS("*", "service")]
    .map((service) => {
      const values = {};
      [...service.children].forEach((child) => { values[localName(child.tagName)] = child.textContent || ""; });
      return values;
    })
    .filter((service) => service.serviceType?.includes("schemas-upnp-org:service:AVTransport:"))
    .sort((a, b) => Number(b.serviceType.split(":").pop()) - Number(a.serviceType.split(":").pop()));
  if (!services.length || !services[0].controlURL) throw new Error("The renderer has no AVTransport service.");
  const friendlyName = document.getElementsByTagNameNS("*", "friendlyName")[0]?.textContent || "UPnP renderer";
  const service = services[0];
  renderer = { friendlyName, serviceType: service.serviceType, controlUrl: new URL(service.controlURL, url).toString() };
  return renderer;
}

export async function loadBridgeRenderer(bridgeUrl = getBridgeUrl()) {
  const renderers = await discoverBridgeRenderers(bridgeUrl);
  return selectBridgeRenderer(renderers[0], bridgeUrl);
}

export async function discoverBridgeRenderers(bridgeUrl = getBridgeUrl()) {
  const normalized = normalizeBridgeUrl(bridgeUrl);
  const response = await fetch(`${normalized}/renderers`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`UPnP bridge returned HTTP ${response.status}.`);
  const payload = await response.json();
  discoveredRenderers = Array.isArray(payload.renderers) ? payload.renderers : [];
  if (!discoveredRenderers.length) throw new Error("The bridge found no UPnP renderer.");
  return discoveredRenderers;
}

export function selectBridgeRenderer(found, bridgeUrl = getBridgeUrl(), remember = true) {
  if (!found?.id) throw new Error("The selected renderer has no device identifier.");
  const normalized = normalizeBridgeUrl(bridgeUrl);
  renderer = { ...found, mode: "bridge", bridgeUrl: normalized };
  if (remember) {
    storageSet(BRIDGE_URL_KEY, normalized);
    storageSet(RENDERER_KEY, JSON.stringify({
      bridgeUrl: normalized,
      id: String(found.id),
      friendlyName: found.friendlyName || found.name || "UPnP renderer",
    }));
  }
  window.dispatchEvent(new CustomEvent("playback-output-change"));
  return renderer;
}

export async function restoreSavedRenderer() {
  const saved = getSavedRendererPreference();
  if (!saved) return null;
  const renderers = await discoverBridgeRenderers(saved.bridgeUrl);
  const found = renderers.find((candidate) => String(candidate.id) === String(saved.id));
  if (!found) throw new Error(`${saved.friendlyName || "The saved renderer"} was not found.`);
  return selectBridgeRenderer(found, saved.bridgeUrl, false);
}

function value(document, name) {
  return [...document.getElementsByTagNameNS("*", name)][0]?.textContent || "";
}

export async function callRenderer(action, argumentsList = []) {
  if (!renderer) throw new Error("No UPnP renderer is connected.");
  if (renderer.mode === "bridge") {
    const actions = { Play: "play", Pause: "pause", Stop: "stop", Next: "next", Previous: "previous" };
    const bridgeAction = actions[action];
    if (!bridgeAction) throw new Error(`${action} is not supported by the bridge yet.`);
    const response = await fetch(`${renderer.bridgeUrl}/renderers/${encodeURIComponent(renderer.id)}/${bridgeAction}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) throw new Error(`${action} returned HTTP ${response.status}.`);
    return response.json();
  }
  const document = documentFromString(`<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${SOAP_NS}" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${renderer.serviceType}"></u:${action}></s:Body></s:Envelope>`);
  const actionNode = document.getElementsByTagNameNS(renderer.serviceType, action)[0];
  argumentsList.forEach(([name, argument]) => {
    const node = document.createElementNS(renderer.serviceType, name);
    node.textContent = String(argument ?? "");
    actionNode.appendChild(node);
  });
  const response = await fetch(renderer.controlUrl, {
    method: "POST",
    headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${renderer.serviceType}#${action}"` },
    body: new XMLSerializer().serializeToString(document),
  });
  if (!response.ok) throw new Error(`${action} returned HTTP ${response.status}.`);
  return new DOMParser().parseFromString(await response.text(), "application/xml");
}

function documentFromString(source) {
  return new DOMParser().parseFromString(source, "application/xml");
}

function escapeXml(value) {
  return String(value || "").replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[character]));
}

export function didlMetadata({ id, title, artist, album, mime = "audio/flac", duration = "" }, uri) {
  return `<?xml version="1.0" encoding="UTF-8"?><DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="${escapeXml(id)}" parentID="0" restricted="1"><dc:title>${escapeXml(title)}</dc:title><upnp:artist>${escapeXml(artist)}</upnp:artist><upnp:album>${escapeXml(album)}</upnp:album><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:${escapeXml(mime)}:*"${duration ? ` duration="${escapeXml(duration)}"` : ""}>${escapeXml(uri)}</res></item></DIDL-Lite>`;
}

export async function setCurrentAndNext(current, next, items = null) {
  if (renderer?.mode === "bridge") {
    const response = await fetch(`${renderer.bridgeUrl}/renderers/${encodeURIComponent(renderer.id)}/queue`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current, next, ...(items ? { items } : {}) }),
    });
    if (!response.ok) throw new Error(`Queue returned HTTP ${response.status}.`);
    return response.json();
  }
  await callRenderer("SetAVTransportURI", [["InstanceID", 0], ["CurrentURI", current.uri], ["CurrentURIMetaData", current.metadata || ""]]);
  if (next) await callRenderer("SetNextAVTransportURI", [["InstanceID", 0], ["NextURI", next.uri], ["NextURIMetaData", next.metadata || ""]]);
}

export async function setNext(next) {
  if (renderer?.mode === "bridge") {
    const response = await fetch(`${renderer.bridgeUrl}/renderers/${encodeURIComponent(renderer.id)}/nexturi`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ next }),
    });
    if (!response.ok) throw new Error(`Next queue returned HTTP ${response.status}.`);
    return response.json();
  }
  await callRenderer("SetNextAVTransportURI", [["InstanceID", 0], ["NextURI", next.uri], ["NextURIMetaData", next.metadata || ""]]);
}

export async function playRenderer() {
  await callRenderer("Play", [["InstanceID", 0], ["Speed", "1"]]);
}

export async function getRendererState() {
  if (!renderer) throw new Error("No UPnP renderer is connected.");
  if (renderer.mode !== "bridge") return null;
  const response = await fetch(`${renderer.bridgeUrl}/renderers/${encodeURIComponent(renderer.id)}/state`);
  if (!response.ok) throw new Error(`Renderer state returned HTTP ${response.status}.`);
  return response.json();
}

export function getRenderer() { return renderer; }

export function disconnectRenderer() {
  renderer = null;
  storageRemove(RENDERER_KEY);
  window.dispatchEvent(new CustomEvent("playback-output-change"));
}
