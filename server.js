#!/usr/bin/env node
/**
 * Streaming server with selectable runtime mode (RTMP, WebRTC, or both)
 *
 * Install:  npm install node-media-server express ws
 * Run (both, default):           node server.js
 * Run (RTMP only, PowerShell):   $env:STREAM_MODE='rtmp'; node server.js
 * Run (WebRTC only, PowerShell): $env:STREAM_MODE='webrtc'; node server.js
 *
 * RTMP mode: Streamlabs Mobile settings (Custom RTMP):
 *   Server:     rtmp://<tailscale-ip>/live
 *   Stream key: stream          ← or any word you like
 *
 * RTMP mode OBS — add a Browser Source:
 *   URL:             http://localhost:8080/obs
 *   Width/Height:    Match your canvas
 *   Shutdown source when not visible: OFF
 *   Control audio via OBS: ON
 *
 * WebRTC pages (default port 8090):
 *   Streamer input:   http://localhost:8090/
 *   Viewer page:      http://localhost:8090/view
 *   OBS source:       http://localhost:8090/obs
 */

'use strict';

const fs              = require('fs');
const NodeMediaServer = require('node-media-server');
const express         = require('express');
const http            = require('http');
const https           = require('https');
const WS              = require('ws');

// ── Ports ──────────────────────────────────────────────────────────────────
const RTMP_PORT   = 1935;   // standard RTMP — no firewall tricks needed for OBS
const STATUS_PORT = 8080;   // status page (browser)
const HTTP_PORT   = 8000;   // node-media-server HTTP-FLV/API
const WEBRTC_PORT = Number(process.env.WEBRTC_PORT || 8090);
const BIND_HOST   = process.env.BIND_HOST || '0.0.0.0';
const STREAM_MODE = (process.env.STREAM_MODE || 'both').toLowerCase(); // rtmp | webrtc | both
const VALID_MODES = new Set(['rtmp', 'webrtc', 'both']);
const EFFECTIVE_MODE = VALID_MODES.has(STREAM_MODE) ? STREAM_MODE : 'both';
const ENABLE_RTMP = EFFECTIVE_MODE !== 'webrtc';
const ENABLE_WEBRTC = EFFECTIVE_MODE !== 'rtmp';

if (!VALID_MODES.has(STREAM_MODE)) {
  console.warn(`[WARN] Unsupported STREAM_MODE=${STREAM_MODE}; defaulting to both.`);
}

if (ENABLE_RTMP && ENABLE_WEBRTC && WEBRTC_PORT === STATUS_PORT) {
  console.error('[ERROR] WEBRTC_PORT cannot equal STATUS_PORT when running both modes.');
  process.exit(1);
}

// ── node-media-server config ───────────────────────────────────────────────
const nmsConfig = {
  bind: BIND_HOST,
  logType: 1,   // 0=none 1=errors 2=info 3=debug

  rtmp: {
    port:         RTMP_PORT,
    chunk_size:   60000,
    gop_cache:    true,   // caches last keyframe so viewers get video immediately
    ping:         30,
    ping_timeout: 60,
  },

  http: {
    port:         HTTP_PORT,
    allow_origin: '*',
    mediaroot:    './media',  // where recordings land (if you enable them)
  },

  // Optional: uncomment to also accept SRT streams (e.g. from Larix Broadcaster)
  // requires node-media-server ≥ 2.6 and libsrt installed
  // srt: {
  //   port: 10080,
  //   chunk_size: 60000,
  // },
};

const nms = new NodeMediaServer(nmsConfig);

// ── Track active streams so the status page can show them ─────────────────
const activeStreams = new Map();   // streamPath → { startedAt, clientId, session? }

const getMediaSnapshot = (session) => {
  if (!session || typeof session !== 'object') {
    return {
      audioCodec: 0,
      audioChannels: 0,
      audioSamplerate: 0,
      videoCodec: 0,
      videoWidth: 0,
      videoHeight: 0,
      videoFramerate: 0,
    };
  }

  return {
    audioCodec: Number(session.audioCodec || 0),
    audioChannels: Number(session.audioChannels || 0),
    audioSamplerate: Number(session.audioSamplerate || 0),
    videoCodec: Number(session.videoCodec || 0),
    videoWidth: Number(session.videoWidth || 0),
    videoHeight: Number(session.videoHeight || 0),
    videoFramerate: Number(session.videoFramerate || 0),
  };
};

const logPublishMediaDetails = (streamPath, clientId, session) => {
  const media = getMediaSnapshot(session);
  console.log(
    `[~] Publish media  id=${clientId}  path=${streamPath || '<missing>'}` +
    `  audioCodec=${media.audioCodec} channels=${media.audioChannels} samplerate=${media.audioSamplerate}` +
    `  videoCodec=${media.videoCodec} size=${media.videoWidth}x${media.videoHeight} fps=${media.videoFramerate}`
  );
};

const formatSessionId = (id) => {
  if (id == null) {
    return '';
  }
  if (typeof id === 'string' || typeof id === 'number') {
    return String(id);
  }
  if (typeof id === 'object') {
    if (typeof id.id === 'string' || typeof id.id === 'number') {
      return String(id.id);
    }
    if (typeof id.sessionID === 'string' || typeof id.sessionID === 'number') {
      return String(id.sessionID);
    }
  }
  return '[session]';
};

const parsePublishEvent = (...eventArgs) => {
  // NMS v4 emits a single session object; older versions emit id, streamPath, args.
  if (eventArgs.length === 1 && eventArgs[0] && typeof eventArgs[0] === 'object') {
    const session = eventArgs[0];
    return {
      clientId: formatSessionId(session.id),
      streamPath: typeof session.streamPath === 'string' ? session.streamPath : '',
      args: session.args && typeof session.args === 'object' ? session.args : {},
      session,
    };
  }

  return {
    clientId: formatSessionId(eventArgs[0]),
    streamPath: typeof eventArgs[1] === 'string' ? eventArgs[1] : '',
    args: eventArgs[2] && typeof eventArgs[2] === 'object' ? eventArgs[2] : {},
    session: null,
  };
};

const parsePlayEvent = (...eventArgs) => {
  // NMS v4 emits a single session object; older versions emit id, streamPath, args.
  if (eventArgs.length === 1 && eventArgs[0] && typeof eventArgs[0] === 'object') {
    const session = eventArgs[0];
    return {
      clientId: formatSessionId(session.id),
      streamPath: typeof session.streamPath === 'string' ? session.streamPath : '',
      protocol: typeof session.protocol === 'string' ? session.protocol : 'unknown',
    };
  }

  return {
    clientId: formatSessionId(eventArgs[0]),
    streamPath: typeof eventArgs[1] === 'string' ? eventArgs[1] : '',
    protocol: 'unknown',
  };
};

nms.on('prePublish', (...eventArgs) => {
  const { clientId, streamPath, session } = parsePublishEvent(...eventArgs);
  if (!streamPath) {
    console.warn(`[!] Stream started  id=${clientId}  path=<missing>`);
    return;
  }
  console.log(`[+] Stream started  id=${clientId}  path=${streamPath}`);
  activeStreams.set(streamPath, { startedAt: new Date(), clientId, session });
});

nms.on('postPublish', (...eventArgs) => {
  const { clientId, streamPath, session } = parsePublishEvent(...eventArgs);
  // Metadata is often populated moments after publish starts.
  setTimeout(() => {
    logPublishMediaDetails(streamPath, clientId, session);
  }, 2500);
});

nms.on('donePublish', (...eventArgs) => {
  const { clientId, streamPath } = parsePublishEvent(...eventArgs);
  console.log(`[-] Stream stopped  id=${clientId}  path=${streamPath}`);
  if (streamPath) {
    activeStreams.delete(streamPath);
    return;
  }

  // Fallback for missing stream path: remove any stream published by this client id.
  for (const [path, info] of activeStreams.entries()) {
    if (info.clientId === clientId) {
      activeStreams.delete(path);
      break;
    }
  }
});

nms.on('postPlay', (...eventArgs) => {
  const { clientId, streamPath, protocol } = parsePlayEvent(...eventArgs);
  console.log(`[>] Player connected  id=${clientId}  protocol=${protocol}  path=${streamPath || '<missing>'}`);
});

nms.on('donePlay', (...eventArgs) => {
  const { clientId, streamPath, protocol } = parsePlayEvent(...eventArgs);
  console.log(`[<] Player disconnected  id=${clientId}  protocol=${protocol}  path=${streamPath || '<missing>'}`);
});

// ── Optional stream key auth ───────────────────────────────────────────────
// Uncomment and set STREAM_KEY env var to restrict who can publish:
//
// const ALLOWED_KEY = process.env.STREAM_KEY;
// nms.on('prePublish', (id, streamPath, args) => {
//   if (ALLOWED_KEY && args.key !== ALLOWED_KEY) {
//     const session = nms.getSession(id);
//     session.reject();
//   }
// });

// ── Status page ────────────────────────────────────────────────────────────
const STATUS_HTML = (streams) => {
  const firstStreamPath = streams.length > 0 ? streams[0][0] : '';
  const rows = streams.length === 0
    ? `<tr><td colspan="3" class="empty">No active streams</td></tr>`
    : streams.map(([path, info]) => {
        const elapsed = Math.floor((Date.now() - info.startedAt) / 1000);
        const hms = [
          Math.floor(elapsed / 3600),
          Math.floor((elapsed % 3600) / 60),
          elapsed % 60,
        ].map(n => String(n).padStart(2, '0')).join(':');
        return `<tr>
          <td><span class="dot live"></span> LIVE</td>
          <td><code>rtmp://localhost${path}</code></td>
          <td>${hms}</td>
        </tr>`;
      }).join('');

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>RTMP Server Status</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f0f0f; color: #e0e0e0;
      font-family: system-ui, -apple-system, sans-serif;
      padding: 40px 24px; max-width: 760px; margin: auto;
    }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 8px 12px; color: #888; font-weight: 500;
         border-bottom: 1px solid #222; }
    td { padding: 10px 12px; border-bottom: 1px solid #1a1a1a; }
    .empty { color: #555; font-style: italic; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
           background: #555; margin-right: 6px; }
    .dot.live { background: #ff3b30; animation: blink 1.2s ease-in-out infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }
    code { background: #1a1a1a; padding: 2px 7px; border-radius: 5px; font-size: 12px; }
    .section { margin-top: 36px; }
    .section h2 { font-size: 15px; color: #888; font-weight: 500; margin-bottom: 12px; }
    .card { background: #161616; border: 1px solid #222; border-radius: 10px;
            padding: 16px 20px; margin-bottom: 10px; line-height: 1.8; font-size: 13px; }
    .card b { color: #fff; }
    .hint { color: #666; font-size: 12px; margin-top: 4px; }
    .player-shell {
      background: #161616;
      border: 1px solid #222;
      border-radius: 10px;
      padding: 14px;
      overflow: hidden;
    }
    .player {
      width: 100%;
      background: #000;
      border-radius: 8px;
      display: block;
      aspect-ratio: 16 / 9;
    }
    .player-note { color: #888; font-size: 12px; margin-top: 10px; }
  </style>
</head>
<body>
  <h1>📡 RTMP Server</h1>

  <table>
    <thead><tr><th>Status</th><th>Stream URL</th><th>Uptime</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="section">
    <h2>Web Player (Live Preview)</h2>
    <div class="player-shell">
      <video id="livePlayer" class="player" controls autoplay muted playsinline></video>
      <div id="playerNote" class="player-note">Waiting for an active stream.</div>
    </div>
  </div>

  <div class="section">
    <h2>Streamlabs Mobile — Custom RTMP</h2>
    <div class="card">
      <b>Server URL</b><br>
      <code>rtmp://&lt;tailscale-ip&gt;/live</code><br>
      <span class="hint">Find your Tailscale IP with: <code>tailscale ip -4</code></span>
    </div>
    <div class="card">
      <b>Stream Key</b><br>
      <code>stream</code>
      <span class="hint"> (or any word — just match it in OBS)</span>
    </div>
  </div>

  <div class="section">
    <h2>OBS — Browser Source</h2>
    <div class="card">
      <b>URL</b><br>
      <code>http://localhost:${STATUS_PORT}/obs</code><br>
      <span class="hint">Sources → + → Browser Source → paste URL above</span><br>
      <span class="hint">Set Width/Height to your canvas and keep source active when hidden.</span><br>
      <span class="hint">For sound: enable "Control audio via OBS" on the Browser Source.</span>
    </div>
  </div>

  <p style="margin-top:32px;font-size:11px;color:#444">Tip: Start publishing to preview live video here.</p>

  <script src="https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js"></script>
  <script>
    (() => {
      const initialStreamPath = ${JSON.stringify(firstStreamPath)};
      const note = document.getElementById('playerNote');
      const video = document.getElementById('livePlayer');
      let currentStreamPath = '';
      let flvPlayer = null;

      const stopPlayer = () => {
        if (flvPlayer) {
          flvPlayer.destroy();
          flvPlayer = null;
        }
        currentStreamPath = '';
      };

      const syncPlayer = (streamPath) => {
        if (!streamPath) {
          stopPlayer();
          note.textContent = 'No active stream yet. Start Streamlabs/RTMP publish first.';
          return;
        }

        if (streamPath === currentStreamPath) {
          return;
        }

        stopPlayer();

        if (!window.flvjs || !flvjs.isSupported()) {
          note.textContent = 'This browser does not support FLV playback via flv.js.';
          return;
        }

        const flvUrl = location.protocol + '//' + location.hostname + ':${HTTP_PORT}' + streamPath + '.flv';

        flvPlayer = flvjs.createPlayer({
          type: 'flv',
          isLive: true,
          url: flvUrl,
        });

        flvPlayer.attachMediaElement(video);
        flvPlayer.load();
        flvPlayer.play().catch(() => {
          note.textContent = 'Click play to start preview.';
        });

        currentStreamPath = streamPath;
        note.textContent = 'Live preview connected.';
      };

      const pollStreams = async () => {
        try {
          const response = await fetch('/api/streams', { cache: 'no-store' });
          if (!response.ok) {
            throw new Error('Status API unavailable');
          }
          const data = await response.json();
          const nextStreamPath = Array.isArray(data.streams) && data.streams.length > 0
            ? data.streams[0].path
            : '';
          syncPlayer(nextStreamPath);
        } catch (_) {
          if (!currentStreamPath) {
            note.textContent = 'Waiting for stream status updates...';
          }
        }
      };

      syncPlayer(initialStreamPath);
      pollStreams();
      setInterval(pollStreams, 5000);

      window.addEventListener('beforeunload', () => {
        stopPlayer();
      });
    })();
  </script>
</body>
</html>`;
};

const OBS_HTML = () => {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OBS Browser Source</title>
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent;
    }
    #stage {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      background: transparent;
    }
    #live {
      width: 100%;
      height: 100%;
      object-fit: fill;
      display: block;
      background: transparent;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div id="stage">
    <video id="live" autoplay playsinline></video>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/flv.js@1.6.2/dist/flv.min.js"></script>
  <script>
    (() => {
      const video = document.getElementById('live');
      let currentStreamPath = '';
      let flvPlayer = null;
      let audioContext = null;
      let audioSourceNode = null;

      const stopPlayer = () => {
        if (flvPlayer) {
          flvPlayer.destroy();
          flvPlayer = null;
        }
        currentStreamPath = '';
      };

      const ensureAudio = () => {
        video.defaultMuted = false;
        video.muted = false;
        video.volume = 1;

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
          return;
        }

        if (!audioContext) {
          audioContext = new AudioCtx();
        }

        if (!audioSourceNode) {
          audioSourceNode = audioContext.createMediaElementSource(video);
          audioSourceNode.connect(audioContext.destination);
        }

        if (audioContext.state !== 'running') {
          audioContext.resume().catch(() => {});
        }
      };

      const startPlayer = (streamPath) => {
        if (!streamPath || streamPath === currentStreamPath) {
          return;
        }

        stopPlayer();
        ensureAudio();

        if (!window.flvjs || !flvjs.isSupported()) {
          return;
        }

        const flvUrl = location.protocol + '//' + location.hostname + ':${HTTP_PORT}' + streamPath + '.flv';

        flvPlayer = flvjs.createPlayer({
          type: 'flv',
          isLive: true,
          url: flvUrl,
        });

        flvPlayer.attachMediaElement(video);
        flvPlayer.load();
        flvPlayer.play().then(() => {
          ensureAudio();
        }).catch(() => {});
        currentStreamPath = streamPath;
      };

      const pollStreams = async () => {
        try {
          const response = await fetch('/api/streams', { cache: 'no-store' });
          if (!response.ok) {
            return;
          }

          const data = await response.json();
          const nextStreamPath = Array.isArray(data.streams) && data.streams.length > 0
            ? data.streams[0].path
            : '';

          if (!nextStreamPath) {
            stopPlayer();
            return;
          }

          startPlayer(nextStreamPath);
        } catch (_) {
          // Keep polling; stream may not be live yet.
        }
      };

      pollStreams();
      setInterval(pollStreams, 2000);

      setInterval(() => {
        if (flvPlayer) {
          ensureAudio();
          if (video.paused) {
            video.play().catch(() => {});
          }
        }
      }, 1000);

      window.addEventListener('beforeunload', () => {
        stopPlayer();
      });
    })();
  </script>
</body>
</html>`;
};

const WEBRTC_STREAMER_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WebRTC Streamer</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #000; color: #fff; font-family: system-ui, sans-serif;
      min-height: 100dvh; display: flex; flex-direction: column;
      align-items: center; gap: 14px; padding: 20px 16px;
    }
    h2 { font-size: 20px; font-weight: 700; }
    video {
      width: 100%; max-width: 480px; border-radius: 14px;
      background: #111; aspect-ratio: 16/9; object-fit: cover;
    }
    button {
      padding: 14px 36px; font-size: 17px; font-weight: 600;
      border-radius: 50px; border: none; cursor: pointer;
      background: #007AFF; color: #fff;
    }
    button:disabled { background: #333; color: #666; }
    #status { font-size: 14px; color: #aaa; }
  </style>
</head>
<body>
  <h2>WebRTC Streamer</h2>
  <video id="preview" autoplay muted playsinline></video>
  <button id="start">Start Camera</button>
  <div id="status">Connecting to signaling...</div>

  <script>
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '?role=streamer');
    const statusEl = document.getElementById('status');
    let pc = null;
    let localStream = null;

    const setStatus = (text) => { statusEl.textContent = text; };

    ws.onopen = () => setStatus('Connected. Tap Start Camera.');
    ws.onclose = () => setStatus('Signaling disconnected.');
    ws.onerror = () => setStatus('WebSocket error.');

    ws.onmessage = async ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === 'viewer-ready' && localStream) {
        await createOffer();
      } else if (msg.type === 'answer' && pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      } else if (msg.type === 'ice' && pc) {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      }
    };

    async function createOffer() {
      if (pc) {
        pc.close();
        pc = null;
      }
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) ws.send(JSON.stringify({ type: 'ice', candidate }));
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
      setStatus('Offer sent. Waiting for viewer.');
    }

    document.getElementById('start').addEventListener('click', async () => {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true,
        });
        document.getElementById('preview').srcObject = localStream;
        document.getElementById('start').disabled = true;
        document.getElementById('start').textContent = 'Camera Active';
        ws.send(JSON.stringify({ type: 'streamer-ready' }));
        setStatus('Camera active. Open /view or /obs to receive stream.');
      } catch (err) {
        setStatus('Camera error: ' + err.message);
      }
    });
  </script>
</body>
</html>`;

const WEBRTC_VIEWER_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>WebRTC Viewer</title>
  <style>
    body {
      background: #0a0a0a; color: #fff; font-family: system-ui, sans-serif;
      margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px;
    }
    video {
      width: min(1280px, 100%);
      aspect-ratio: 16/9;
      background: #111;
      border-radius: 12px;
    }
  </style>
</head>
<body>
  <video id="video" autoplay playsinline controls></video>

  <script>
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '?role=viewer');
    const video = document.getElementById('video');
    let pc = null;

    ws.onmessage = async ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === 'offer') {
        await handleOffer(msg.sdp);
      } else if (msg.type === 'ice' && pc) {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      } else if (msg.type === 'streamer-gone') {
        video.srcObject = null;
      }
    };

    async function handleOffer(sdp) {
      if (pc) {
        pc.close();
        pc = null;
      }

      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      pc.ontrack = ({ streams }) => {
        if (video.srcObject !== streams[0]) {
          video.srcObject = streams[0];
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) ws.send(JSON.stringify({ type: 'ice', candidate }));
      };

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
    }
  </script>
</body>
</html>`;

const WEBRTC_OBS_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>OBS WebRTC Source</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      background: transparent;
      overflow: hidden;
    }
    #video {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      background: transparent;
    }
  </style>
</head>
<body>
  <video id="video" autoplay playsinline></video>

  <script>
    const params = new URLSearchParams(location.search);
    if (params.get('fit') === 'cover') {
      document.getElementById('video').style.objectFit = 'cover';
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const video = document.getElementById('video');
    let ws = null;
    let pc = null;
    let reconnectTimer = null;

    const connect = () => {
      if (ws) ws.close();
      ws = new WebSocket(proto + '//' + location.host + '?role=viewer');

      ws.onclose = ws.onerror = () => {
        if (pc) {
          pc.close();
          pc = null;
        }
        video.srcObject = null;
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onmessage = async ({ data }) => {
        const msg = JSON.parse(data);
        if (msg.type === 'offer') {
          await handleOffer(msg.sdp);
        } else if (msg.type === 'ice' && pc) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
        } else if (msg.type === 'streamer-gone') {
          if (pc) {
            pc.close();
            pc = null;
          }
          video.srcObject = null;
        }
      };
    };

    async function handleOffer(sdp) {
      if (pc) {
        pc.close();
        pc = null;
      }

      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      pc.ontrack = ({ streams }) => {
        if (video.srcObject !== streams[0]) {
          video.srcObject = streams[0];
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) ws.send(JSON.stringify({ type: 'ice', candidate }));
      };

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
    }

    connect();
  </script>
</body>
</html>`;

const startWebRtcMode = () => {
  const app = express();
  let signalingServer;
  const hasTls = fs.existsSync('cert.pem') && fs.existsSync('key.pem');

  if (hasTls) {
    signalingServer = https.createServer(
      { cert: fs.readFileSync('cert.pem'), key: fs.readFileSync('key.pem') },
      app
    );
    console.log('HTTPS enabled for WebRTC mode.');
  } else {
    signalingServer = http.createServer(app);
    console.warn('No cert.pem/key.pem found. WebRTC mode is running on HTTP.');
    console.warn('Safari/iOS camera capture may require HTTPS.');
  }

  app.get('/', (_, res) => {
    res.type('html').send(WEBRTC_STREAMER_HTML);
  });

  app.get('/view', (_, res) => {
    res.type('html').send(WEBRTC_VIEWER_HTML);
  });

  app.get('/obs', (_, res) => {
    res.type('html').send(WEBRTC_OBS_HTML);
  });

  const wss = new WS.Server({ server: signalingServer });
  let streamer = null;
  let viewer = null;

  const send = (ws, obj) => {
    if (ws && ws.readyState === WS.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  };

  wss.on('connection', (ws, req) => {
    const role = new URL(`http://x${req.url}`).searchParams.get('role');

    if (role === 'streamer') {
      if (streamer) streamer.close();
      streamer = ws;
      console.log('[+] WebRTC streamer connected');

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'streamer-ready') {
          if (viewer) send(streamer, { type: 'viewer-ready' });
        } else {
          send(viewer, msg);
        }
      });

      ws.on('close', () => {
        console.log('[-] WebRTC streamer disconnected');
        streamer = null;
        send(viewer, { type: 'streamer-gone' });
      });
      return;
    }

    if (role === 'viewer') {
      if (viewer) viewer.close();
      viewer = ws;
      console.log('[+] WebRTC viewer connected');

      if (streamer) send(streamer, { type: 'viewer-ready' });

      ws.on('message', (raw) => {
        send(streamer, JSON.parse(raw));
      });

      ws.on('close', () => {
        console.log('[-] WebRTC viewer disconnected');
        viewer = null;
      });
    }
  });

  signalingServer.listen(WEBRTC_PORT, BIND_HOST, () => {
    const protocol = hasTls ? 'https' : 'http';
    console.log('\nWebRTC mode ready');
    console.log(`   Streamer page: ${protocol}://localhost:${WEBRTC_PORT}/`);
    console.log(`   Viewer page:   ${protocol}://localhost:${WEBRTC_PORT}/view`);
    console.log(`   OBS source:    ${protocol}://localhost:${WEBRTC_PORT}/obs\n`);
  });
};

if (ENABLE_RTMP) {
  const app = express();
  app.get('/', (_, res) => {
    res.type('html').send(STATUS_HTML([...activeStreams.entries()]));
  });

  app.get('/obs', (_, res) => {
    res.type('html').send(OBS_HTML());
  });

  app.get('/api/streams', (_, res) => {
    const streams = [...activeStreams.entries()].map(([path, info]) => ({
      path,
      startedAt: info.startedAt.toISOString(),
      clientId: info.clientId,
      media: getMediaSnapshot(info.session),
    }));
    res.json({ streams });
  });

  const statusServer = http.createServer(app);
  statusServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n[ERROR] Status page port ${STATUS_PORT} is already in use.`);
      console.error('        Another server instance is likely already running.');
      console.error('        Stop it first, then run: node server.js\n');
      process.exit(1);
    }
    throw err;
  });

  statusServer.listen(STATUS_PORT, () => {
    // Start NMS only after the status page port is confirmed available.
    nms.run();

    console.log('\nRTMP mode ready');
    console.log(`   RTMP ingest:   rtmp://${BIND_HOST}:${RTMP_PORT}/live`);
    console.log(`   OBS source:    http://localhost:${STATUS_PORT}/obs`);
    console.log(`   Status page:   http://localhost:${STATUS_PORT}/`);
    console.log(`   HTTP-FLV/API:  http://localhost:${HTTP_PORT}/\n`);
  });
}

if (ENABLE_WEBRTC) {
  startWebRtcMode();
}

// ── Start ──────────────────────────────────────────────────────────────────
