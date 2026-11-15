#!/usr/bin/env node
/*
 * Phase 2B-0 deployment spike: stand-in server. THROWAWAY, NOT PRODUCTION.
 *
 * Dependency-free (Node 18+). It is NOT an ESP32 and does NOT speak
 * protocol v2. It only lets the spike page measure what a phone browser can
 * do against a LAN server:
 *
 *   GET  /, /spike.html, /spike.js   the test page (these files only)
 *   GET  /ping                       JSON, CORS + Private Network Access headers
 *   GET  /generate_204               HTTP 204. An APPLICATION endpoint test only.
 *                                    It does NOT reproduce Android's own
 *                                    connectivity check (see README-SPIKE.md).
 *   POST /result                     saves the page's result JSON in RESULTS_DIR
 *   WS   /ws                         RFC 6455 text-frame echo with test modes
 *
 * WebSocket test modes (switch with {"t":"CTL","mode":...}):
 *   echo    (default) answer every {"t":"ECHO"} with an {"t":"ECHO"} reply
 *   silent  keep the socket OPEN and keep reading, but send no ECHO replies
 *           (an unresponsive peer whose socket still looks open)
 *   pause   stop READING the socket for `ms` ms (a backlog builds up), then resume
 *   drop    destroy the TCP connection with no close frame
 *
 * Environment:
 *   PORT          HTTP port (default 8080)
 *   HTTPS_PORT    HTTPS port (default 8443; used only when CERT_FILE and KEY_FILE are set)
 *   CERT_FILE, KEY_FILE   PEM files, see make-cert.sh
 *   RESULTS_DIR   where /result files go (default ./results next to this file)
 *
 * SECURITY: no authentication. Run it only on a private Codespaces port or a
 * trusted LAN. Do not commit certificate keys.
 */

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_BODY = 2 * 1024 * 1024;
const MAX_FRAME = 1024 * 1024;

const STATIC = {
  "/": ["spike.html", "text/html; charset=utf-8"],
  "/spike.html": ["spike.html", "text/html; charset=utf-8"],
  "/spike.js": ["spike.js", "text/javascript; charset=utf-8"]
};

/* ---------------- WebSocket (RFC 6455), server side, text frames ---------------- */

export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/* Parses as many complete client frames as `buffer` holds. */
export function parseFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let pos = offset + 2;

    if (length === 126) {
      if (buffer.length - pos < 2) break;
      length = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (length === 127) {
      if (buffer.length - pos < 8) break;
      const big = buffer.readBigUInt64BE(pos);
      if (big > BigInt(MAX_FRAME)) return { frames, rest: buffer.subarray(offset), error: "frame too large" };
      length = Number(big);
      pos += 8;
    }

    if (length > MAX_FRAME) return { frames, rest: buffer.subarray(offset), error: "frame too large" };

    let mask = null;
    if (masked) {
      if (buffer.length - pos < 4) break;
      mask = buffer.subarray(pos, pos + 4);
      pos += 4;
    }

    if (buffer.length - pos < length) break;

    const payload = Buffer.from(buffer.subarray(pos, pos + length));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];

    frames.push({ fin, opcode, masked, payload });
    offset = pos + length;
  }

  return { frames, rest: buffer.subarray(offset), error: null };
}

function acceptWebSocket(req, socket, ctx) {

  const key = req.headers["sec-websocket-key"];

  if (String(req.headers.upgrade).toLowerCase() !== "websocket" || !key) {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const id = ++ctx.connections;
  const conn = { id, mode: "echo", buffer: Buffer.alloc(0), fragments: [], closed: false };
  ctx.log(`ws #${id} open from ${req.socket.remoteAddress}`);

  const sendText = obj => {
    if (conn.closed || socket.destroyed) return;
    socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj))));
  };

  const closeNow = (code = 1000) => {
    if (conn.closed) return;
    conn.closed = true;
    try {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      socket.end(encodeFrame(0x8, payload));
    } catch { socket.destroy(); }
  };

  const onText = text => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "CTL") {
      const mode = String(msg.mode);
      if (mode === "echo" || mode === "silent") {
        conn.mode = mode;
        sendText({ t: "CTL_OK", mode, serverNow: Date.now() });
      } else if (mode === "pause") {
        const ms = Math.min(Math.max(Number(msg.ms) || 8000, 100), 60000);
        sendText({ t: "CTL_OK", mode, ms, serverNow: Date.now() });
        // Stop reading: the sender's messages pile up in TCP buffers.
        setTimeout(() => { socket.pause(); }, 20);
        setTimeout(() => { if (!socket.destroyed) socket.resume(); ctx.log(`ws #${id} resumed after ${ms} ms`); }, 20 + ms);
      } else if (mode === "drop") {
        sendText({ t: "CTL_OK", mode, serverNow: Date.now() });
        setTimeout(() => { conn.closed = true; socket.destroy(); }, 50);   // no close frame
      }
      return;
    }

    if (msg.t === "ECHO" && conn.mode === "echo") {
      sendText({ t: "ECHO", n: msg.n, ts: msg.ts, serverNow: Date.now() });
    }
  };

  socket.on("data", chunk => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    const { frames, rest, error } = parseFrames(conn.buffer);
    conn.buffer = Buffer.from(rest);
    if (error) { closeNow(1009); return; }

    for (const frame of frames) {
      if (!frame.masked) { closeNow(1002); return; }            // clients must mask
      if (frame.opcode === 0x8) { closeNow(1000); return; }
      if (frame.opcode === 0x9) { socket.write(encodeFrame(0xA, frame.payload)); continue; }
      if (frame.opcode === 0xA) continue;
      if (frame.opcode === 0x1 || frame.opcode === 0x0) {
        if (frame.opcode === 0x1) conn.fragments = [];
        conn.fragments.push(frame.payload);
        if (frame.fin) {
          onText(Buffer.concat(conn.fragments).toString("utf8"));
          conn.fragments = [];
        }
      }
    }
  });

  socket.on("close", () => { conn.closed = true; ctx.log(`ws #${id} closed`); });
  socket.on("error", () => { conn.closed = true; });

  sendText({ t: "HELLO_STANDIN", id, serverNow: Date.now(), note: "stand-in server, not protocol v2" });
}

/* ---------------- HTTP ---------------- */

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Private-Network": "true",
    ...extra
  };
}

function handleHttp(req, res, ctx) {

  const url = new URL(req.url, "http://placeholder");
  const route = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === "GET" && STATIC[route]) {
    const [file, type] = STATIC[route];
    try {
      const body = fs.readFileSync(path.join(HERE, file));
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("missing " + file);
    }
    return;
  }

  if (req.method === "GET" && route === "/ping") {
    res.writeHead(200, corsHeaders({ "Content-Type": "application/json", "Cache-Control": "no-store" }));
    res.end(JSON.stringify({ ok: true, serverNow: Date.now() }));
    return;
  }

  if (req.method === "GET" && route === "/generate_204") {
    res.writeHead(204, corsHeaders({ "Cache-Control": "no-store" }));
    res.end();
    return;
  }

  if (req.method === "POST" && route === "/result") {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { res.writeHead(413, corsHeaders()); res.end(); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      try {
        const obj = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const variant = String(obj.variant || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "unknown";
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const name = `${variant}-${stamp}.json`;
        obj.serverReceivedAt = new Date().toISOString();
        obj.clientAddress = req.socket.remoteAddress;
        fs.mkdirSync(ctx.resultsDir, { recursive: true });
        fs.writeFileSync(path.join(ctx.resultsDir, name), JSON.stringify(obj, null, 2));
        ctx.log(`result saved: ${name}`);
        res.writeHead(200, corsHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ saved: name }));
      } catch (error) {
        res.writeHead(400, corsHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ error: String(error.message) }));
      }
    });
    return;
  }

  res.writeHead(404, corsHeaders());
  res.end("not found");
}

/* ---------------- server factory ---------------- */

export function createSpikeServer({
  port = 8080,
  httpsPort = null,
  cert = null,
  key = null,
  host = "0.0.0.0",
  resultsDir = path.join(HERE, "results"),
  log = () => {}
} = {}) {

  const ctx = { resultsDir, log, connections: 0 };
  const servers = [];

  const attach = server => {
    server.on("upgrade", (req, socket) => {
      const route = new URL(req.url, "http://placeholder").pathname;
      if (route !== "/ws") { socket.destroy(); return; }
      acceptWebSocket(req, socket, ctx);
    });
  };

  const httpServer = http.createServer((req, res) => handleHttp(req, res, ctx));
  attach(httpServer);
  servers.push({ scheme: "http", server: httpServer, port });

  if (cert && key && httpsPort !== null) {
    const httpsServer = https.createServer({ cert, key }, (req, res) => handleHttp(req, res, ctx));
    attach(httpsServer);
    servers.push({ scheme: "https", server: httpsServer, port: httpsPort });
  }

  return {
    start() {
      return Promise.all(servers.map(entry => new Promise((resolve, reject) => {
        entry.server.once("error", reject);
        entry.server.listen(entry.port, host, () => {
          entry.port = entry.server.address().port;
          resolve();
        });
      }))).then(() => servers.map(entry => ({ scheme: entry.scheme, port: entry.port })));
    },
    close() {
      return Promise.all(servers.map(entry => new Promise(resolve => {
        entry.server.closeAllConnections?.();
        entry.server.close(() => resolve());
      })));
    },
    resultsDir
  };
}

/* ---------------- command line ---------------- */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {

  const port = Number(process.env.PORT || 8080);
  const certFile = process.env.CERT_FILE;
  const keyFile = process.env.KEY_FILE;
  const httpsPort = certFile && keyFile ? Number(process.env.HTTPS_PORT || 8443) : null;
  const stamp = () => new Date().toISOString().slice(11, 23);

  const spike = createSpikeServer({
    port,
    httpsPort,
    cert: certFile ? fs.readFileSync(certFile) : null,
    key: keyFile ? fs.readFileSync(keyFile) : null,
    resultsDir: process.env.RESULTS_DIR || path.join(HERE, "results"),
    log: message => console.log(`[${stamp()}] ${message}`)
  });

  const listening = await spike.start();

  console.log("Phase 2B-0 spike stand-in server (throwaway; not an ESP32; not protocol v2)");
  console.log(`results dir: ${spike.resultsDir}`);
  for (const { scheme, port: p } of listening) {
    console.log(`${scheme.toUpperCase()} listening on ${p}`);
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const a of addresses || []) {
        if (a.family === "IPv4" && !a.internal) console.log(`  ${scheme}://${a.address}:${p}/spike.html`);
      }
    }
  }
  if (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN) {
    console.log(`Codespaces URL (keep the port PRIVATE): https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/spike.html`);
  }
  console.log("Ctrl+C to stop.");
}
