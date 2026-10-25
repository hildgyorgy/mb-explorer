#!/usr/bin/env python3
"""Minimal local UPnP AVTransport bridge for MusiCards."""

import json
import html
import ipaddress
import os
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/"
AVT_PREFIX = "urn:schemas-upnp-org:service:AVTransport:"
PORT = int(os.environ.get("MUSICARDS_BRIDGE_PORT", "9181"))
HOST = os.environ.get("MUSICARDS_BRIDGE_HOST", "0.0.0.0")
PARENT_PID = int(os.environ.get("MUSICARDS_BRIDGE_PARENT_PID", "0") or 0)
PROXY_TTL_SECONDS = 6 * 60 * 60
DEFAULT_ALLOWED_ORIGINS = {"https://hildgyorgy.github.io"}
ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS | {
    origin.strip().rstrip("/")
    for origin in os.environ.get("MUSICARDS_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
}


def xml_value(node, name):
    return next((x.text or "" for x in node.iter()
                 if x.tag.rsplit("}", 1)[-1] == name), "")


def discover():
    message = ("M-SEARCH * HTTP/1.1\r\n"
               "HOST: 239.255.255.250:1900\r\n"
               'MAN: "ssdp:discover"\r\nMX: 1\r\n'
               "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(1.5)
    found = {}
    try:
        sock.sendto(message.encode(), ("239.255.255.250", 1900))
        while True:
            try:
                data, address = sock.recvfrom(65535)
            except socket.timeout:
                break
            headers = {}
            for line in data.decode("utf-8", "replace").split("\r\n"):
                if ":" in line:
                    key, value = line.split(":", 1)
                    headers[key.lower()] = value.strip()
            location = headers.get("location")
            if location:
                found[location] = {"location": location, "address": address[0]}
    finally:
        sock.close()
    return list(found.values())


def renderer_from_description(url, address=""):
    with urllib.request.urlopen(url, timeout=5) as response:
        root = ET.fromstring(response.read())
    services = []
    for service in root.iter():
        if service.tag.rsplit("}", 1)[-1] != "service":
            continue
        service_type = xml_value(service, "serviceType")
        control = xml_value(service, "controlURL")
        if service_type.startswith(AVT_PREFIX) and control:
            services.append((service_type, urllib.parse.urljoin(url, control)))
    if not services:
        raise RuntimeError("AVTransport service not found")
    service_type, control_url = max(services, key=lambda x: x[0].rsplit(":", 1)[-1])
    return {"id": xml_value(root, "UDN") or url,
            "descriptionUrl": url, "address": address,
            "friendlyName": xml_value(root, "friendlyName") or "UPnP renderer",
            "manufacturer": xml_value(root, "manufacturer"),
            "modelName": xml_value(root, "modelName"),
            "serviceType": service_type, "controlUrl": control_url}


def local_address_for(renderer):
    target = renderer.get("address") or urllib.parse.urlsplit(
        renderer.get("controlUrl", "")).hostname
    if not target:
        raise RuntimeError("Renderer network address is unavailable")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect((target, 1900))
        return sock.getsockname()[0]
    finally:
        sock.close()


def soap_call(renderer, action, arguments=()):
    envelope = ET.Element(ET.QName(SOAP_NS, "Envelope"),
                         {ET.QName(SOAP_NS, "encodingStyle"):
                          "http://schemas.xmlsoap.org/soap/encoding/"})
    body = ET.SubElement(envelope, ET.QName(SOAP_NS, "Body"))
    action_node = ET.SubElement(body, ET.QName(renderer["serviceType"], action))
    for name, value in arguments:
        ET.SubElement(action_node, name).text = str(value)
    request = urllib.request.Request(
        renderer["controlUrl"], data=ET.tostring(envelope, encoding="utf-8",
        xml_declaration=True), method="POST",
        headers={"Content-Type": 'text/xml; charset="utf-8"',
                 "SOAPAction": f'"{renderer["serviceType"]}#{action}"'})
    with urllib.request.urlopen(request, timeout=15) as response:
        return ET.fromstring(response.read())


def soap_text(renderer, action, arguments=(), names=()):
    root = soap_call(renderer, action, arguments)
    values = {node.tag.rsplit("}", 1)[-1]: (node.text or "") for node in root.iter()}
    return {name: values.get(name, "") for name in names}


class BridgeState:
    def __init__(self):
        self.lock = threading.Lock()
        self.renderers = {}
        self.queue = {}
        self.last_next = {}
        self.last_current = {}
        self.proxy_sources = {}
        self.proxy_uris = {}
        self.proxy_originals = {}

    def refresh(self):
        with self.lock:
            for item in discover():
                try:
                    renderer = renderer_from_description(
                        item["location"], item.get("address", ""))
                    self.renderers[renderer["id"]] = renderer
                except Exception:
                    continue
            return list(self.renderers.values())

    def get(self, renderer_id):
        with self.lock:
            renderer = self.renderers.get(renderer_id)
        if not renderer:
            self.refresh()
            renderer = self.renderers.get(renderer_id)
        if not renderer:
            raise KeyError("renderer not found")
        return renderer

    def proxy_item(self, renderer, item):
        original_uri = str(item.get("uri") or "")
        if not original_uri:
            raise ValueError("queue item has no URI")
        renderer_uri = str(item.get("rendererUri") or "")
        if renderer_uri:
            metadata = str(item.get("metadata") or "")
            metadata = metadata.replace(
                html.escape(original_uri, quote=False),
                html.escape(renderer_uri, quote=False))
            direct = {**item, "uri": renderer_uri, "metadata": metadata,
                      "originalUri": original_uri}
            with self.lock:
                self.proxy_originals[renderer_uri] = original_uri
                while len(self.proxy_originals) > 512:
                    self.proxy_originals.pop(next(iter(self.proxy_originals)))
            return direct
        token = secrets.token_urlsafe(24)
        proxy_uri = (f"http://{local_address_for(renderer)}:{PORT}"
                     f"/proxy/{token}")
        metadata = str(item.get("metadata") or "")
        escaped_original = html.escape(original_uri, quote=False)
        escaped_proxy = html.escape(proxy_uri, quote=False)
        if metadata:
            metadata = metadata.replace(escaped_original, escaped_proxy)
        proxied = {**item, "uri": proxy_uri, "metadata": metadata,
                   "originalUri": original_uri}
        with self.lock:
            self.proxy_sources[token] = (original_uri, time.monotonic())
            self.proxy_uris[token] = proxy_uri
            self.proxy_originals[proxy_uri] = original_uri
            while len(self.proxy_sources) > 256:
                oldest_token = next(iter(self.proxy_sources))
                self.proxy_sources.pop(oldest_token, None)
                oldest_proxy_uri = self.proxy_uris.pop(oldest_token, "")
                self.proxy_originals.pop(oldest_proxy_uri, None)
        return proxied

    def proxy_source(self, token):
        with self.lock:
            entry = self.proxy_sources.get(token)
            if not entry:
                return None
            source, created_at = entry
            if time.monotonic() - created_at <= PROXY_TTL_SECONDS:
                return source
            self.proxy_sources.pop(token, None)
            proxy_uri = self.proxy_uris.pop(token, "")
            self.proxy_originals.pop(proxy_uri, None)
            return None

    def original_uri(self, uri):
        with self.lock:
            return self.proxy_originals.get(uri, uri)


STATE = BridgeState()


def queue_watcher():
    while True:
        threading.Event().wait(1)
        with STATE.lock:
            queues = list(STATE.queue.items())
            renderers = dict(STATE.renderers)
        for renderer_id, items in queues:
            renderer = renderers.get(renderer_id)
            if not renderer or not items:
                continue
            try:
                current = soap_text(renderer, "GetMediaInfo", [("InstanceID", 0)], ("CurrentURI",)).get("CurrentURI", "")
                index = next((i for i, item in enumerate(items) if item.get("uri") == current), -1)
                if index < 0 or index + 1 >= len(items):
                    continue
                changed = bool(STATE.last_current.get(renderer_id)) and STATE.last_current.get(renderer_id) != current
                next_item = items[index + 1]
                if STATE.last_next.get(renderer_id) == next_item.get("uri"):
                    continue
                soap_call(renderer, "SetNextAVTransportURI", [("InstanceID", 0),
                    ("NextURI", next_item["uri"]),
                    ("NextURIMetaData", next_item.get("metadata", ""))])
                STATE.last_next[renderer_id] = next_item.get("uri")
                STATE.last_current[renderer_id] = current
                if changed:
                    state = soap_text(renderer, "GetTransportInfo", [("InstanceID", 0)], ("CurrentTransportState",)).get("CurrentTransportState", "")
                    if state == "STOPPED":
                        soap_call(renderer, "Play", [("InstanceID", 0), ("Speed", 1)])
            except Exception:
                continue


threading.Thread(target=queue_watcher, daemon=True).start()


def parent_watcher():
    if not PARENT_PID:
        return
    while True:
        threading.Event().wait(1)
        if os.getppid() != PARENT_PID:
            os._exit(0)


if PARENT_PID:
    threading.Thread(target=parent_watcher, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def allowed_origin(self):
        origin = self.headers.get("Origin", "").strip().rstrip("/")
        if not origin:
            return ""
        if origin in ALLOWED_ORIGINS:
            return origin
        try:
            parsed = urllib.parse.urlsplit(origin)
            if parsed.scheme in {"http", "https"} and parsed.hostname in {
                    "localhost", "127.0.0.1", "::1"}:
                return origin
        except ValueError:
            pass
        return None

    def is_loopback_client(self):
        try:
            return ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            return False

    def allow_control_request(self):
        return self.is_loopback_client() and self.allowed_origin() is not None

    def send_cors_headers(self):
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def send_json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        if not self.allow_control_request():
            return self.send_json(403, {"error": "local control access denied"})
        self.send_response(204)
        self.send_cors_headers()
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        if self.headers.get("Access-Control-Request-Private-Network") == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def proxy_audio(self, token, head_only=False):
        source = STATE.proxy_source(token)
        if not source:
            return self.send_json(404, {"error": "stream token not found"})
        headers = {"User-Agent": "MusicBrainz-Explorer-Bridge/0.1"}
        if self.headers.get("Range"):
            headers["Range"] = self.headers["Range"]
        request = urllib.request.Request(
            source, headers=headers, method="HEAD" if head_only else "GET")
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            self.send_response(response.status)
            for name in ("Content-Type", "Content-Length", "Content-Range",
                         "Accept-Ranges", "Last-Modified", "ETag"):
                value = response.headers.get(name)
                if value:
                    self.send_header(name, value)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if head_only:
                return
            while True:
                chunk = response.read(128 * 1024)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break

    def do_GET(self):
        try:
            path = urllib.parse.urlsplit(self.path).path
            parts = path.strip("/").split("/")
            if len(parts) == 2 and parts[0] == "proxy":
                return self.proxy_audio(parts[1])
            if not self.allow_control_request():
                return self.send_json(403, {"error": "local control access denied"})
            if self.path == "/health":
                return self.send_json(200, {"ok": True})
            if self.path == "/renderers":
                return self.send_json(200, {"renderers": STATE.refresh()})
            if len(parts) == 3 and parts[0] == "renderers" and parts[2] == "state":
                renderer = STATE.get(urllib.parse.unquote(parts[1]))
                transport = soap_text(renderer, "GetTransportInfo", [("InstanceID", 0)], ("CurrentTransportState", "CurrentTransportStatus"))
                position = soap_text(renderer, "GetPositionInfo", [("InstanceID", 0)], ("TrackDuration", "RelTime", "Track"))
                media = soap_text(renderer, "GetMediaInfo", [("InstanceID", 0)], ("CurrentURI",))
                media["CurrentURI"] = STATE.original_uri(media.get("CurrentURI", ""))
                return self.send_json(200, {**transport, **position, **media})
            return self.send_json(404, {"error": "not found"})
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def do_HEAD(self):
        try:
            parts = urllib.parse.urlsplit(self.path).path.strip("/").split("/")
            if len(parts) == 2 and parts[0] == "proxy":
                return self.proxy_audio(parts[1], head_only=True)
            self.send_response(404)
            self.end_headers()
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def do_POST(self):
        try:
            if not self.allow_control_request():
                return self.send_json(403, {"error": "local control access denied"})
            parts = urllib.parse.urlsplit(self.path).path.strip("/").split("/")
            if len(parts) < 2 or parts[0] != "renderers":
                return self.send_json(404, {"error": "not found"})
            renderer = STATE.get(urllib.parse.unquote(parts[1]))
            body = self.read_json()
            action = parts[2] if len(parts) > 2 else ""
            if action == "queue":
                source_items = body.get("items") or [body["current"]] + ([body["next"]] if body.get("next") else [])
                items = [STATE.proxy_item(renderer, item) for item in source_items]
                current = items[0]
                next_uri = items[1] if len(items) > 1 else None
                soap_call(renderer, "SetAVTransportURI", [("InstanceID", 0),
                    ("CurrentURI", current["uri"]),
                    ("CurrentURIMetaData", current.get("metadata", ""))])
                next_uri_set = False
                if next_uri:
                    try:
                        soap_call(renderer, "SetNextAVTransportURI", [("InstanceID", 0),
                            ("NextURI", next_uri["uri"]),
                            ("NextURIMetaData", next_uri.get("metadata", ""))])
                        next_uri_set = True
                    except Exception:
                        # SetNextAVTransportURI is optional. The current item can
                        # still play on renderers that do not implement it.
                        pass
                with STATE.lock:
                    STATE.queue[renderer["id"]] = items
                    STATE.last_next[renderer["id"]] = (
                        next_uri.get("uri") if next_uri_set else None)
                return self.send_json(200, {"ok": True,
                                            "nextUriSet": next_uri_set})
            if action == "nexturi":
                item = STATE.proxy_item(renderer, body["next"])
                soap_call(renderer, "SetNextAVTransportURI", [("InstanceID", 0),
                    ("NextURI", item["uri"]),
                    ("NextURIMetaData", item.get("metadata", ""))])
                return self.send_json(200, {"ok": True})
            if action == "seek":
                seconds = max(0, int(body.get("seconds", 0)))
                target = f"0:{seconds // 60:02d}:{seconds % 60:02d}"
                soap_call(renderer, "Seek", [("InstanceID", 0), ("Unit", "REL_TIME"), ("Target", target)])
                return self.send_json(200, {"ok": True})
            if action in {"play", "pause", "stop", "next", "previous"}:
                names = {"play": ("Play", [("Speed", 1)]),
                         "pause": ("Pause", []), "stop": ("Stop", []),
                         "next": ("Next", [("Unit", "TRACK")]),
                         "previous": ("Previous", [("Unit", "TRACK")])}
                name, args = names[action]
                soap_call(renderer, name, [("InstanceID", 0)] + args)
                return self.send_json(200, {"ok": True})
            return self.send_json(404, {"error": "unknown action"})
        except KeyError as error:
            self.send_json(404, {"error": str(error)})
        except Exception as error:
            self.send_json(502, {"error": str(error)})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"MusicBrainz Explorer UPnP bridge listening on http://{HOST}:{PORT}",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
