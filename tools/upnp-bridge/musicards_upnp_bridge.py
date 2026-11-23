#!/usr/bin/env python3
"""Minimal local UPnP AVTransport bridge for MusiCards."""

import json
import html
import ipaddress
import mimetypes
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/"
AVT_PREFIX = "urn:schemas-upnp-org:service:AVTransport:"
BRIDGE_VERSION = "0.2.1"
PORT = int(os.environ.get("MUSICARDS_BRIDGE_PORT", "9181"))
HOST = os.environ.get("MUSICARDS_BRIDGE_HOST", "0.0.0.0")
PARENT_PID = int(os.environ.get("MUSICARDS_BRIDGE_PARENT_PID", "0") or 0)
RENDERER_IP = os.environ.get("MUSICARDS_RENDERER_IP", "").strip()
SITE_ROOT = (Path(os.environ["MUSICARDS_SITE_ROOT"]).resolve()
             if os.environ.get("MUSICARDS_SITE_ROOT") else
             (Path(sys.executable).resolve().parent.parent / "site"
              if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent.parent))
SITE_TOP_LEVEL = {"index.html", "support.html", "site.webmanifest", "icon.png",
                  "favicon.ico", "favicon-16x16.png", "favicon-32x32.png",
                  "apple-touch-icon.png", "android-chrome-192x192.png",
                  "android-chrome-512x512.png"}
PROXY_TTL_SECONDS = 6 * 60 * 60
DEFAULT_ALLOWED_ORIGINS = {"https://hildgyorgy.github.io"}
ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS | {
    origin.strip().rstrip("/")
    for origin in os.environ.get("MUSICARDS_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
}
ALLOWED_HOSTS = {host.strip().lower() for host in
                 os.environ.get("MUSICARDS_ALLOWED_HOSTS", "").split(",")
                 if host.strip()}


def xml_value(node, name):
    return next((x.text or "" for x in node.iter()
                 if x.tag.rsplit("}", 1)[-1] == name), "")


def upnp_clock(value):
    hours, remaining = divmod(max(0, int(value)), 3600)
    minutes, seconds = divmod(remaining, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}"


def private_lan_address(value):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        return None
    ranges = (ipaddress.IPv4Network("10.0.0.0/8"),
              ipaddress.IPv4Network("172.16.0.0/12"),
              ipaddress.IPv4Network("192.168.0.0/16"))
    return address if any(address in network for network in ranges) else None


def mac_multicast_interface():
    try:
        route = subprocess.run(
            ["/sbin/route", "-n", "get", "239.255.255.250"],
            capture_output=True, text=True, timeout=2, check=False)
        return next((line.split(":", 1)[1].strip()
                     for line in route.stdout.splitlines()
                     if line.strip().startswith("interface:")), "")
    except (OSError, subprocess.TimeoutExpired):
        return ""


def mac_subnet_candidates(interface):
    if not interface:
        return []
    try:
        details = subprocess.run(["/sbin/ifconfig", interface],
                                 capture_output=True, text=True, timeout=2,
                                 check=False).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    match = re.search(r"\binet\s+(\d+\.\d+\.\d+\.\d+)\s+netmask\s+(0x[\da-fA-F]+|\d+\.\d+\.\d+\.\d+)", details)
    if not match:
        return []
    address = private_lan_address(match.group(1))
    if not address:
        return []
    mask = match.group(2)
    if mask.startswith("0x"):
        mask = str(ipaddress.IPv4Address(int(mask, 16)))
    try:
        network = ipaddress.IPv4Network(f"{address}/{mask}", strict=False)
    except ValueError:
        return []
    if network.num_addresses > 256:
        network = ipaddress.IPv4Network(f"{address}/24", strict=False)
    return [str(host) for host in network.hosts() if host != address]


def receive_ssdp(sock, found, duration):
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        sock.settimeout(max(0.01, deadline - time.monotonic()))
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


def discover():
    message = ("M-SEARCH * HTTP/1.1\r\n"
               "HOST: 239.255.255.250:1900\r\n"
               'MAN: "ssdp:discover"\r\nMX: 1\r\n'
               "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    found = {}
    try:
        interface = ""
        if sys.platform == "darwin":
            # macOS can reject multicast with EHOSTUNREACH unless the socket is
            # bound to the interface selected by its multicast route.
            interface = mac_multicast_interface()
            try:
                if interface:
                    sock.setsockopt(socket.IPPROTO_IP, 25, socket.if_nametoindex(interface))
            except OSError:
                pass
        for target in ("urn:schemas-upnp-org:device:MediaRenderer:2",
                       "urn:schemas-upnp-org:device:MediaRenderer:1"):
            multicast_message = message.replace(
                "ST: urn:schemas-upnp-org:device:MediaRenderer:1", f"ST: {target}")
            try:
                sock.sendto(multicast_message.encode(), ("239.255.255.250", 1900))
            except OSError:
                if not RENDERER_IP and sys.platform != "darwin":
                    raise
        direct_address = private_lan_address(RENDERER_IP) if RENDERER_IP else None
        if direct_address:
            try:
                direct_message = message.replace(
                    "HOST: 239.255.255.250:1900", f"HOST: {direct_address}:1900").replace(
                    "ST: urn:schemas-upnp-org:device:MediaRenderer:1", "ST: ssdp:all")
                sock.sendto(direct_message.encode(), (str(direct_address), 1900))
            except OSError:
                pass
        receive_ssdp(sock, found, 3 if direct_address else 1.5)
        if not found and sys.platform == "darwin":
            # Match the native app's bounded /24 deep search when multicast
            # misses a renderer across wired/Wi-Fi network segments.
            targets = ("urn:schemas-upnp-org:device:MediaRenderer:2",
                       "urn:schemas-upnp-org:device:MediaRenderer:1",
                       "upnp:rootdevice")
            for host in mac_subnet_candidates(interface):
                for target in targets:
                    direct_message = message.replace(
                        "HOST: 239.255.255.250:1900", f"HOST: {host}:1900").replace(
                        "ST: urn:schemas-upnp-org:device:MediaRenderer:1", f"ST: {target}")
                    try:
                        sock.sendto(direct_message.encode(), (host, 1900))
                    except OSError:
                        continue
            receive_ssdp(sock, found, 4)
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
        self.scan_lock = threading.Lock()
        self.renderers = {}
        self.queue = {}
        self.last_next = {}
        self.last_current = {}
        self.proxy_sources = {}
        self.proxy_uris = {}
        self.proxy_originals = {}

    def refresh(self):
        if not self.scan_lock.acquire(blocking=False):
            with self.lock:
                cached = list(self.renderers.values())
            if cached:
                return cached
            with self.scan_lock:
                with self.lock:
                    return list(self.renderers.values())
        try:
            found = {}
            for item in discover():
                try:
                    renderer = renderer_from_description(
                        item["location"], item.get("address", ""))
                    found[renderer["id"]] = renderer
                except Exception:
                    continue
            with self.lock:
                self.renderers.update(found)
                return list(self.renderers.values())
        finally:
            self.scan_lock.release()

    def get(self, renderer_id):
        with self.lock:
            renderer = self.renderers.get(renderer_id)
        if not renderer:
            self.refresh()
            with self.lock:
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
                with STATE.lock:
                    if STATE.queue.get(renderer_id) is not items:
                        continue
                soap_call(renderer, "SetNextAVTransportURI", [("InstanceID", 0),
                    ("NextURI", next_item["uri"]),
                    ("NextURIMetaData", next_item.get("metadata", ""))])
                STATE.last_next[renderer_id] = next_item.get("uri")
                STATE.last_current[renderer_id] = current
                if changed:
                    state = soap_text(renderer, "GetTransportInfo", [("InstanceID", 0)], ("CurrentTransportState",)).get("CurrentTransportState", "")
                    if state == "STOPPED":
                        with STATE.lock:
                            if STATE.queue.get(renderer_id) is not items:
                                continue
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

    def host_allowed(self):
        try:
            host = urllib.parse.urlsplit("//" + self.headers.get("Host", "")).hostname
        except ValueError:
            return False
        if not host:
            return False
        host = host.lower()
        if host in {"localhost", "127.0.0.1", "::1"} | ALLOWED_HOSTS:
            return True
        # Tailscale Serve forwards the public HTTPS page's requests to this
        # loopback listener. Its ts.net Host is safe only with an allowed Origin.
        return (host.endswith(".ts.net") and
                self.headers.get("Origin", "").strip().rstrip("/") in ALLOWED_ORIGINS)

    def allow_control_request(self):
        return (self.is_loopback_client() and self.host_allowed() and
                self.allowed_origin() is not None)

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

    def serve_site(self, path, head_only=False):
        if not self.is_loopback_client() or not self.host_allowed():
            self.send_error(403, "Local website access only")
            return
        relative = urllib.parse.unquote(path).lstrip("/") or "index.html"
        if relative not in SITE_TOP_LEVEL and not relative.startswith("assets/"):
            self.send_error(404, "Not found")
            return
        target = (SITE_ROOT / relative).resolve()
        try:
            target.relative_to(SITE_ROOT / "assets" if relative.startswith("assets/") else SITE_ROOT)
        except ValueError:
            self.send_error(404, "Not found")
            return
        if not target.is_file():
            self.send_error(404, "Not found")
            return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if target.suffix in {".js", ".mjs"}:
            content_type = "text/javascript"
        size = target.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if not head_only:
            with target.open("rb") as source:
                while chunk := source.read(128 * 1024):
                    self.wfile.write(chunk)

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
        headers = {"User-Agent": f"MusicBrainz-Explorer-Bridge/{BRIDGE_VERSION}"}
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
            if path == "/" or path.lstrip("/") in SITE_TOP_LEVEL or path.startswith("/assets/"):
                return self.serve_site(path)
            if not self.allow_control_request():
                return self.send_json(403, {"error": "local control access denied"})
            if self.path == "/health":
                return self.send_json(200, {"ok": True})
            if path == "/renderers":
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
            path = urllib.parse.urlsplit(self.path).path
            parts = path.strip("/").split("/")
            if len(parts) == 2 and parts[0] == "proxy":
                return self.proxy_audio(parts[1], head_only=True)
            if path == "/" or path.lstrip("/") in SITE_TOP_LEVEL or path.startswith("/assets/"):
                return self.serve_site(path, head_only=True)
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
                target = upnp_clock(body.get("seconds", 0))
                soap_call(renderer, "Seek", [("InstanceID", 0), ("Unit", "REL_TIME"), ("Target", target)])
                return self.send_json(200, {"ok": True})
            if action in {"play", "pause", "stop", "next", "previous"}:
                names = {"play": ("Play", [("Speed", 1)]),
                         "pause": ("Pause", []), "stop": ("Stop", []),
                         "next": ("Next", [("Unit", "TRACK")]),
                         "previous": ("Previous", [("Unit", "TRACK")])}
                name, args = names[action]
                if action == "stop":
                    with STATE.lock:
                        STATE.queue.pop(renderer["id"], None)
                        STATE.last_current.pop(renderer["id"], None)
                        STATE.last_next.pop(renderer["id"], None)
                soap_call(renderer, name, [("InstanceID", 0)] + args)
                return self.send_json(200, {"ok": True})
            return self.send_json(404, {"error": "unknown action"})
        except KeyError as error:
            self.send_json(404, {"error": str(error)})
        except Exception as error:
            self.send_json(502, {"error": str(error)})


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    local_host = "localhost" if HOST in {"0.0.0.0", "::"} else HOST
    print(f"MusicBrainz Explorer UPnP bridge running. Local address: http://{local_host}:{PORT}",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
