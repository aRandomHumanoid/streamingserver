# Video Stream Server

This project runs two live streaming paths:

- RTMP ingest and playback helpers (Node-Media-Server)
- WebRTC streamer/viewer pages with WebSocket signaling

By default, both are available at the same time on different ports.

## Requirements

- Node.js 18+
- npm

## Install

1. Open a terminal in this folder.
2. Install dependencies:

```powershell
npm install
```

## Run

### Default (both RTMP and WebRTC)

```powershell
node server.js
```

### RTMP only

```powershell
$env:STREAM_MODE='rtmp'; node server.js
```

### WebRTC only

```powershell
$env:STREAM_MODE='webrtc'; node server.js
```

### Optional custom WebRTC port

```powershell
$env:WEBRTC_PORT='8091'; node server.js
```

## Ports

- 1935: RTMP ingest
- 8000: HTTP-FLV service (internal playback pipeline)
- 8080: RTMP status page and OBS Browser Source page for RTMP mode
- 8090: WebRTC streamer/viewer/OBS pages (default, configurable with WEBRTC_PORT)

If you run both modes, 8080 and 8090 must be different.

## RTMP Mode Quick Start

Use this when streaming from apps like Streamlabs Mobile to RTMP.

### Stream publisher settings

- Server URL: rtmp://<your-machine-ip>/live
- Stream key: stream

### RTMP mode endpoints

- Status page: http://localhost:8080/
- OBS Browser Source page: http://localhost:8080/obs
- Stream diagnostics API: http://localhost:8080/api/streams

### OBS setup (RTMP mode)

1. Add Browser Source.
2. URL: http://localhost:8080/obs
3. Set Width/Height to your canvas size.
4. Enable Control audio via OBS.

## WebRTC Mode Quick Start

Use this when you want browser camera input and browser-based viewing.

### WebRTC endpoints

- Streamer input page: http://localhost:8090/
- Viewer page: http://localhost:8090/view
- OBS Browser Source page: http://localhost:8090/obs

### OBS setup (WebRTC mode)

1. Add Browser Source.
2. URL: http://localhost:8090/obs
3. Set Width/Height to your canvas size.
4. Enable Control audio via OBS.

## iPhone / Safari Note (WebRTC)

Safari camera capture usually requires HTTPS.

If cert.pem and key.pem are present in the project root, WebRTC mode will use HTTPS automatically.

Without certs, WebRTC pages run on HTTP, which may block camera access on iPhone Safari.

## Firewall / Network Notes

- For remote RTMP publishing to this machine, allow inbound TCP 1935.
- For remote access to status or WebRTC pages, allow inbound TCP 8080 and 8090 as needed.
- If OBS runs on the same machine, localhost URLs are correct.

## Troubleshooting

### Port already in use / exit code 1

Another server instance is likely still running.

Stop existing Node processes, then retry:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```

### Video works but no audio in OBS

1. Confirm Control audio via OBS is enabled on Browser Source.
2. In Audio Mixer, ensure the Browser Source is not muted.
3. In Advanced Audio Properties, test Monitor and Output.

### Verify RTMP ingest has audio

Open:

- http://localhost:8080/api/streams

Look for media fields like:

- audioCodec (10 means AAC)
- audioSamplerate (for example 48000)
- audioChannels

### WebRTC camera page fails on iPhone

Use HTTPS (cert.pem/key.pem) or a trusted HTTPS fronting approach, then reopen the streamer page.

## Project Files

- server.js: unified server for RTMP and WebRTC modes
