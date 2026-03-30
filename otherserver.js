#!/usr/bin/env node
/**
 * iPhone → Laptop live streamer via WebRTC + WebSocket signaling
 *
 * Install:  npm install express ws
 * Run:      node server.js
 *
 * Streamer (iPhone):  https://<tailscale-ip>:8080/
 * Viewer   (laptop):  https://localhost:8080/view
 *
 * TLS certs (required for getUserMedia on iPhone):
 *   Option A — Tailscale HTTPS (recommended):
 *     tailscale serve --https=8080 --bg http://localhost:8080
 *     Then access via https://<device>.ts.net/ and https://<device>.ts.net/view
 *
 *   Option B — mkcert (self-signed, trusted locally):
 *     1. winget install FiloSottile.mkcert
 *     2. mkcert -install
 *     3. mkcert <tailscale-ip>     # creates <ip>+1.pem and <ip>+1-key.pem
 *     4. Rename to cert.pem and key.pem in this folder
 *     5. AirDrop the mkcert root CA (mkcert -CAROOT) to your iPhone and
 *        trust it: Settings → General → VPN & Device Management → install,
 *        then Settings → General → About → Certificate Trust Settings → enable
 */

'use strict';

const fs      = require('fs');
const http    = require('http');
const https   = require('https');
const express = require('express');
const WS      = require('ws');

const PORT = 8080;
const app  = express();

// ── TLS setup ──────────────────────────────────────────────────────────────
let server;
if (fs.existsSync('cert.pem') && fs.existsSync('key.pem')) {
  server = https.createServer(
    { cert: fs.readFileSync('cert.pem'), key: fs.readFileSync('key.pem') },
    app
  );
  console.log('✅  HTTPS enabled (cert.pem / key.pem)');
} else {
  server = http.createServer(app);
  console.warn('⚠️   No cert.pem/key.pem found — running HTTP.');
  console.warn('    getUserMedia will be BLOCKED by Safari on iPhone.');
  console.warn('    See the header comment for TLS setup options.\n');
}

// ── Embedded HTML pages ────────────────────────────────────────────────────
const STREAMER_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>📱 Streamer</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #000; color: #fff;
      font-family: -apple-system, sans-serif;
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
      background: #007AFF; color: #fff; transition: opacity .15s;
    }
    button:disabled { background: #333; color: #666; }
    #statusWrap { display: flex; align-items: center; gap: 8px; font-size: 14px; color: #aaa; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #555; flex-shrink: 0; }
    .dot.live { background: #ff3b30; animation: blink 1.2s ease-in-out infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }
    #camRow { display: flex; gap: 10px; }
    select {
      padding: 10px 14px; border-radius: 10px; border: none;
      background: #1c1c1e; color: #fff; font-size: 15px; flex: 1;
    }
  </style>
</head>
<body>
  <h2>📱 iPhone Streamer</h2>
  <video id="preview" autoplay muted playsinline></video>

  <div id="camRow">
    <select id="facing">
      <option value="environment">Back camera</option>
      <option value="user">Front camera</option>
    </select>
    <button id="btn">Start Camera</button>
  </div>

  <div id="statusWrap">
    <span class="dot" id="dot"></span>
    <span id="statusText">Connecting to server…</span>
  </div>

  <script>
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws    = new WebSocket(\`\${proto}//\${location.host}?role=streamer\`);
    let pc = null, localStream = null;

    function setStatus(msg, live = false) {
      document.getElementById('statusText').textContent = msg;
      document.getElementById('dot').className = 'dot' + (live ? ' live' : '');
    }

    ws.onopen  = () => setStatus('Connected — tap Start Camera');
    ws.onclose = () => setStatus('Disconnected from server');
    ws.onerror = () => setStatus('WebSocket error');

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
      if (pc) { pc.close(); pc = null; }
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) ws.send(JSON.stringify({ type: 'ice', candidate }));
      };
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected')                    setStatus('🔴 Live', true);
        if (s === 'disconnected' || s === 'failed') setStatus('Viewer disconnected');
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
      setStatus('Offer sent, connecting…');
    }

    document.getElementById('btn').addEventListener('click', async () => {
      const facing = document.getElementById('facing').value;
      try {
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        localStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true
        });
        document.getElementById('preview').srcObject = localStream;
        document.getElementById('btn').textContent  = 'Camera active ✅';
        document.getElementById('btn').disabled     = true;
        setStatus('Camera ready — open /view on your laptop');
        // Signal server that camera is live (in case a viewer is already waiting)
        ws.send(JSON.stringify({ type: 'streamer-ready' }));
      } catch (err) {
        setStatus('Camera error: ' + err.message);
      }
    });
  </script>
</body>
</html>`;

const VIEWER_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>📺 Viewer</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0a0a; color: #fff;
      font-family: system-ui, sans-serif;
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; padding: 24px; gap: 16px;
    }
    h1 { font-size: 20px; color: #ccc; font-weight: 600; }
    video {
      width: 100%; max-width: 1280px; border-radius: 12px;
      background: #111; aspect-ratio: 16/9;
    }
    #badge {
      padding: 5px 14px; border-radius: 20px; font-size: 13px;
      font-weight: 700; background: #2a2a2a; color: #888; letter-spacing: .5px;
    }
    #badge.live {
      background: #ff3b30; color: #fff;
      animation: blink 1.2s ease-in-out infinite;
    }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.6} }
    #hint { font-size: 13px; color: #555; text-align: center; max-width: 480px; line-height: 1.5; }
    code { background: #1e1e1e; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>📺 iPhone Stream Viewer</h1>
  <video id="video" autoplay playsinline controls></video>
  <span id="badge">⏳ WAITING</span>
  <p id="hint">
    On your iPhone, open<br>
    <code>https://&lt;tailscale-ip&gt;:8080/</code><br>
    and tap <strong>Start Camera</strong>.
  </p>

  <script>
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws    = new WebSocket(\`\${proto}//\${location.host}?role=viewer\`);
    let pc = null;

    ws.onmessage = async ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === 'offer') {
        await handleOffer(msg.sdp);
      } else if (msg.type === 'ice' && pc) {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      } else if (msg.type === 'streamer-gone') {
        setBadge(false);
        document.getElementById('hint').textContent = 'Streamer disconnected. Waiting to reconnect…';
      }
    };

    function setBadge(live) {
      const b = document.getElementById('badge');
      b.className = live ? 'live' : '';
      b.textContent = live ? '🔴 LIVE' : '⏳ WAITING';
    }

    async function handleOffer(sdp) {
      if (pc) { pc.close(); pc = null; }
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      pc.ontrack = ({ streams }) => {
        const v = document.getElementById('video');
        if (v.srcObject !== streams[0]) v.srcObject = streams[0];
        setBadge(true);
        document.getElementById('hint').textContent = 'Streaming from iPhone ✅';
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) ws.send(JSON.stringify({ type: 'ice', candidate }));
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          setBadge(false);
          document.getElementById('hint').textContent = 'WebRTC connection failed — check network/firewall.';
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
    }
  </script>
</body>
</html>`;

// ── OBS Browser Source page ────────────────────────────────────────────────
// Transparent bg, no UI chrome, fills viewport, auto-connects + auto-reconnects.
// In OBS: Add → Browser Source → URL: http://localhost:8080/obs
//         Width: 1920  Height: 1080  ✅ Control audio via OBS
const OBS_HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>OBS Source</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%; height: 100%;
      background: transparent;   /* lets OBS composite beneath */
      overflow: hidden;
    }
    video {
      width: 100%; height: 100%;
      object-fit: contain;       /* change to 'cover' to fill & crop */
      display: block;
      background: transparent;
    }
    /* Offline overlay — hidden once stream arrives */
    #offline {
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      font-family: system-ui, sans-serif;
      font-size: 18px; color: rgba(255,255,255,.45);
      pointer-events: none;
      transition: opacity .4s;
    }
    #offline.hidden { opacity: 0; }
  </style>
</head>
<body>
  <video id="v" autoplay playsinline></video>
  <div id="offline">📵 Waiting for iPhone stream…</div>

  <script>
    // ── Config ──────────────────────────────────────────────────────────────
    // object-fit: pass ?fit=cover in the URL to fill instead of letterbox
    const params = new URLSearchParams(location.search);
    if (params.get('fit') === 'cover')
      document.getElementById('v').style.objectFit = 'cover';

    // ── WebRTC plumbing ─────────────────────────────────────────────────────
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let pc = null, ws = null, reconnTimer = null;

    function connect() {
      if (ws) ws.close();
      ws = new WebSocket(\`\${proto}//\${location.host}?role=viewer\`);

      ws.onopen = () => {
        clearTimeout(reconnTimer);
      };

      ws.onclose = ws.onerror = () => {
        setOffline(true);
        reconnTimer = setTimeout(connect, 3000);   // auto-reconnect
      };

      ws.onmessage = async ({ data }) => {
        const msg = JSON.parse(data);
        if (msg.type === 'offer') {
          await handleOffer(msg.sdp);
        } else if (msg.type === 'ice' && pc) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
        } else if (msg.type === 'streamer-gone') {
          setOffline(true);
          if (pc) { pc.close(); pc = null; }
        }
      };
    }

    async function handleOffer(sdp) {
      if (pc) { pc.close(); pc = null; }
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      pc.ontrack = ({ streams }) => {
        const v = document.getElementById('v');
        if (v.srcObject !== streams[0]) {
          v.srcObject = streams[0];
          setOffline(false);
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) ws.send(JSON.stringify({ type: 'ice', candidate }));
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setOffline(true);
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
    }

    function setOffline(isOffline) {
      const el = document.getElementById('offline');
      el.classList.toggle('hidden', !isOffline);
      if (isOffline) {
        const v = document.getElementById('v');
        v.srcObject = null;
      }
    }

    // OBS reloads the browser source when the scene becomes active.
    // document.addEventListener('visibilitychange', ...) can be used
    // to pause/resume if needed, but auto-reconnect handles this fine.
    connect();
  </script>
</body>
</html>`;

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/',     (_, res) => res.type('html').send(STREAMER_HTML));
app.get('/view', (_, res) => res.type('html').send(VIEWER_HTML));
app.get('/obs',  (_, res) => res.type('html').send(OBS_HTML));

// ── WebSocket signaling (one streamer ↔ one viewer) ────────────────────────
const wss = new WS.Server({ server });
let streamer    = null;  // the iPhone
let viewer      = null;  // the laptop browser

function send(ws, obj) {
  if (ws && ws.readyState === WS.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
  const role = new URL('http://x' + req.url).searchParams.get('role');

  // ── Streamer (iPhone) ────────────────────────────────────────────────────
  if (role === 'streamer') {
    if (streamer) streamer.close();
    streamer = ws;
    console.log('[+] Streamer connected');

    // If a viewer is already waiting, ask the streamer to initiate once it has camera
    // (viewer sends 'viewer-ready' → streamer → offer)

    ws.on('message', raw => {
      const msg = JSON.parse(raw);

      if (msg.type === 'streamer-ready') {
        // Streamer just activated its camera; trigger an offer if viewer is waiting
        if (viewer) send(streamer, { type: 'viewer-ready' });
      } else {
        // offer / ice-candidate → forward to viewer
        send(viewer, msg);
      }
    });

    ws.on('close', () => {
      console.log('[-] Streamer disconnected');
      streamer = null;
      send(viewer, { type: 'streamer-gone' });
    });

  // ── Viewer (laptop browser) ──────────────────────────────────────────────
  } else if (role === 'viewer') {
    if (viewer) viewer.close();
    viewer = ws;
    console.log('[+] Viewer connected');

    // If streamer is connected and has camera, ask it to create an offer
    if (streamer) send(streamer, { type: 'viewer-ready' });

    ws.on('message', raw => {
      // answer / ice-candidate → forward to streamer
      send(streamer, JSON.parse(raw));
    });

    ws.on('close', () => {
      console.log('[-] Viewer disconnected');
      viewer = null;
    });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const proto = (fs.existsSync('cert.pem') ? 'https' : 'http');
  console.log(`\n🚀 Server running on port ${PORT}`);
  console.log(`   Streamer (iPhone):  ${proto}://<tailscale-ip>:${PORT}/`);
  console.log(`   Viewer   (laptop):  ${proto}://localhost:${PORT}/view`);
  console.log(`   OBS source:         http://localhost:${PORT}/obs\n`);
});
