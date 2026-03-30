# planetiler-web

Lokales Planetiler-GUI in Docker (Node.js 24 + OpenJDK 25), mit:

- Web-UI (Tailwind CDN + Leaflet)
- BBOX-Auswahl über Karte + Felder (zwei Wege)
- Live-Logs via SSE
- PMTiles-Downloadlink nach erfolgreicher Generierung
- optionalem Vorab-Download des Baden-Württemberg-Extrakts
- konfigurierbaren Planetiler-Parametern (u.a. min/max zoom + zusätzliche CLI-Args)

## Voraussetzungen

- Docker + Docker Compose

## Quickstart

1. Verzeichnisse anlegen:

```bash
mkdir -p data/input data/output data/sources
```

2. App starten:

```bash
docker compose up --build
```

3. UI öffnen:

```text
http://localhost:8080
```

## Input-Datei

Es gibt zwei Wege:

- In der UI auf **Download Baden-Württemberg Extract** klicken (lädt nach `data/input/input.osm.pbf`)
- oder manuell eine `.osm.pbf` nach `data/input/input.osm.pbf` legen

Quelle für den integrierten Download:
`https://download.geofabrik.de/europe/germany/baden-wuerttemberg-latest.osm.pbf`

## PMTiles generieren

1. BBOX auf der Karte ziehen oder `minX/minY/maxX/maxY` direkt setzen
2. Optional `minZoom` / `maxZoom` setzen
3. Optional zusätzliche Planetiler-Argumente eintragen (eine Zeile pro Argument, z. B. `--threads=8`)
4. **Start Generation** klicken
5. Live-Logs beobachten
6. Nach Abschluss den Download-Link verwenden

Hinweis: Der Generator startet mit `--download`, damit Planetiler fehlende Zusatzdaten
(z. B. `data/sources/lake_centerline.shp.zip`) automatisch nachlaedt.
Der erste Lauf kann dadurch laenger dauern.
Diese Zusatzdaten werden in `data/sources` gespeichert und bei spaeteren Runs wiederverwendet.

## Lokale Entwicklung (ohne Docker)

```bash
pnpm install
pnpm run typecheck
pnpm start
```

Um lokale Pfade zu überschreiben:

```bash
INPUT_FILE=/absoluter/pfad/input.osm.pbf OUTPUT_DIR=/absoluter/pfad/output pnpm start
```

## GitHub Container Registry

Es gibt einen Workflow unter `.github/workflows/docker-publish.yml`, der das Docker-Image baut.

- Bei Pull Requests: nur Build (kein Push)
- Bei Push auf `main`: Build + Push nach `ghcr.io/<owner>/<repo>`
