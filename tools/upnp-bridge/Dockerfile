FROM python:3.12-alpine

WORKDIR /app
COPY tools/upnp-bridge/musicards_upnp_bridge.py /app/
COPY index.html support.html site.webmanifest icon.png favicon.ico \
     favicon-16x16.png favicon-32x32.png apple-touch-icon.png \
     android-chrome-192x192.png android-chrome-512x512.png /app/site/
COPY assets /app/site/assets
ENV MUSICARDS_SITE_ROOT=/app/site
EXPOSE 9181
ENTRYPOINT ["python3", "/app/musicards_upnp_bridge.py"]
