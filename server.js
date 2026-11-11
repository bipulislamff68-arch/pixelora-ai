'use strict';
/**
 * Pixelora server (OpenAI / ChatGPT image model)
 * - Serves index.html and /examples
 * - POST /api/remove-background  -> removes the background (transparent PNG, original pixels kept)
 * - POST /api/ai-background      -> replaces the background with what the user describes in a prompt
 * - GET  /api/example-cutout/:id -> transparent PNG for the homepage examples (cached on disk)
 *
 * Requires Node.js 18+. The OpenAI key stays on the server (OPENAI_API_KEY in .env).
 */
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';           // low | medium | high
const FIDELITY = process.env.OPENAI_INPUT_FIDELITY === undefined ? 'high' : process.env.OPENAI_INPUT_FIDELITY; // '' to disable
const MAX_BYTES = 12 * 1024 * 1024;
const CACHE_DIR = path.join(__dirname, 'cache');
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/* Unsplash photo IDs used by the homepage examples (same IDs as in index.html). */
const EXAMPLE_IDS = new Set([
  '1584917865442-de89df76afd3', '1542291026-7eec264c27ff', '1541643600914-78b084683601',
  '1494790108377-be9c29b29330', '1438761681033-6461ffad8d80', '1544005313-94ddf0286df2',
  '1552053831-71594a27632d', '1514888286974-6c03e2ca1dba', '1537151625747-768eb6cf92b2'
]);

fs.mkdirSync(CACHE_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

/* Small per-IP rate limit (6 AI requests / minute) to protect your OpenAI credits. */
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now(), key = req.ip || 'unknown';
  const list = (hits.get(key) || []).filter(t => now - t < 60000);
  if (list.length >= 6) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  list.push(now); hits.set(key, list); next();
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < 60000)) hits.delete(k); }, 60000).unref();

class AiError extends Error { constructor(message, status) { super(message); this.status = status; } }

/* ---------- image preparation ----------
   The OpenAI image model works on 1024x1024, 1536x1024 or 1024x1536. We fit the photo inside the closest size
   (white padding), send it, then crop the padding off again so the result lines up with the original exactly. */
async function prepare(buffer) {
  let base;
  try { base = await sharp(buffer, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true }); }
  catch (_) { throw new AiError('This image could not be read. Please try another file.', 415); }
  const W0 = base.info.width, H0 = base.info.height, ratio = W0 / H0;
  const tw = ratio > 1.2 ? 1536 : 1024, th = ratio < 0.83 ? 1536 : 1024;
  const scale = Math.min(tw / W0, th / H0);
  const w = Math.max(1, Math.round(W0 * scale)), h = Math.max(1, Math.round(H0 * scale));
  const left = Math.floor((tw - w) / 2), top = Math.floor((th - h) / 2);
  const inner = await sharp(base.data).resize(w, h).flatten({ background: '#ffffff' }).png().toBuffer();
  const padded = await sharp({ create: { width: tw, height: th, channels: 3, background: '#ffffff' } })
    .composite([{ input: inner, left, top }]).png().toBuffer();
  return { orig: base.data, W0, H0, tw, th, w, h, left, top, padded };
}

async function cropResult(prep, resultBuf) {
  const m = await sharp(resultBuf).metadata();
  const sx = m.width / prep.tw, sy = m.height / prep.th;
  const l = Math.min(m.width - 1, Math.max(0, Math.round(prep.left * sx)));
  const t = Math.min(m.height - 1, Math.max(0, Math.round(prep.top * sy)));
  const w = Math.max(1, Math.min(m.width - l, Math.round(prep.w * sx)));
  const h = Math.max(1, Math.min(m.height - t, Math.round(prep.h * sy)));
  return sharp(resultBuf).extract({ left: l, top: t, width: w, height: h }).png().toBuffer();
}

/* Background removal: use the AI's alpha as a mask on the ORIGINAL pixels, so the subject keeps its exact original
   colours and the output keeps the original width and height. */
async function finishRemove(prep, resultBuf) {
  const crop = await cropResult(prep, resultBuf);
  const alpha = await sharp(crop).resize(prep.W0, prep.H0, { fit: 'fill' }).ensureAlpha().extractChannel('alpha').raw().toBuffer();
  const rgb = await sharp(prep.orig).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return sharp(rgb.data, { raw: { width: prep.W0, height: prep.H0, channels: rgb.info.channels } })
    .joinChannel(alpha, { raw: { width: prep.W0, height: prep.H0, channels: 1 } }).png().toBuffer();
}

/* New background: return the AI image cropped to the photo area (never larger than needed for small originals). */
async function finishBackground(prep, resultBuf) {
  const crop = await cropResult(prep, resultBuf);
  const m = await sharp(crop).metadata();
  if (prep.W0 < m.width) return sharp(crop).resize(prep.W0, prep.H0, { fit: 'fill' }).png().toBuffer();
  return crop;
}

/* ---------- OpenAI call ---------- */
async function callOpenAI(paddedPng, prompt, transparent) {
  if (!OPENAI_KEY) throw new AiError('The AI service is not configured on the server (missing OPENAI_API_KEY).', 503);
  const form = new FormData();
  form.append('model', MODEL);
  form.append('prompt', prompt);
  form.append('image', new Blob([paddedPng], { type: 'image/png' }), 'image.png');
  form.append('size', 'auto');
  form.append('quality', QUALITY);
  form.append('output_format', 'png');
  form.append('background', transparent ? 'transparent' : 'opaque');
  if (FIDELITY) form.append('input_fidelity', FIDELITY);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000);
  try {
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: 'Bearer ' + OPENAI_KEY }, body: form, signal: ctrl.signal
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    if (!r.ok) {
      const code = (json && json.error && (json.error.code || json.error.type)) || '';
      console.error('OpenAI error', r.status, code, json && json.error && json.error.message);
      if (code === 'moderation_blocked' || code === 'content_policy_violation') throw new AiError('The AI could not process this request because of its safety rules. Try a different photo or description.', 422);
      if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') throw new AiError('The AI service has no credits left. Please try again later.', 502);
      if (r.status === 401 || r.status === 403) throw new AiError('The AI service rejected the server credentials. Please contact the site owner.', 502);
      if (r.status === 429) throw new AiError('The AI service is busy. Please try again in a moment.', 503);
      if (r.status === 400) throw new AiError('The AI could not process this image. Try a different photo.', 422);
      throw new AiError('The AI service returned an error. Please try again.', 502);
    }
    const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
    if (!b64) throw new AiError('The AI service returned no image. Please try again.', 502);
    return Buffer.from(b64, 'base64');
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e && e.name === 'AbortError') throw new AiError('The AI service took too long to respond. Please try again.', 504);
    console.error('OpenAI request failed', e);
    throw new AiError('Could not reach the AI service. Please try again.', 502);
  } finally { clearTimeout(timer); }
}

const PAD_NOTE = 'Any plain white margins around the photo are only padding.';
const REMOVE_PROMPT = 'Remove the background from this photo. Keep the main subject (person, product or animal) exactly as it is: same position, size, shape, colors, lighting and every fine detail, including edges, hair, fur and small parts. Do not add, move, restyle or retouch anything. Output only the subject on a fully transparent background. ' + PAD_NOTE + ' Treat the padding as background too.';
const bgPrompt = userText => 'Keep the main subject (person, product or animal) of this photo exactly unchanged: same position, size, shape, colors and every detail. Replace only the background with this scene: "' + userText + '". The new background must fill the entire image, including any plain white margins (they are only padding). Make lighting and perspective look natural.';

async function removeBackground(buffer) {
  const prep = await prepare(buffer);
  const result = await callOpenAI(prep.padded, REMOVE_PROMPT, true);
  return finishRemove(prep, result);
}

/* ---------- routes ---------- */
app.get('/api/health', (req, res) => res.json({ ok: true, aiConfigured: !!OPENAI_KEY, model: MODEL }));

function checkFile(req) {
  if (!req.file) throw new AiError('No image was uploaded.', 400);
  if (!ALLOWED_MIME.has(req.file.mimetype)) throw new AiError('Unsupported image type. Please use JPG, PNG or WebP.', 415);
}

app.post('/api/remove-background', rateLimit, upload.single('image'), async (req, res) => {
  try {
    checkFile(req);
    const png = await removeBackground(req.file.buffer);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).send(png);
  } catch (e) { res.status(e.status || 500).json({ error: e.message || 'Background removal failed.' }); }
});

app.post('/api/ai-background', rateLimit, upload.single('image'), async (req, res) => {
  try {
    checkFile(req);
    const text = String((req.body && req.body.prompt) || '').replace(/[\u0000-\u001f"]/g, ' ').trim().slice(0, 300);
    if (text.length < 3) throw new AiError('Please describe the new background first.', 400);
    const prep = await prepare(req.file.buffer);
    const result = await callOpenAI(prep.padded, bgPrompt(text), false);
    const png = await finishBackground(prep, result);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }).send(png);
  } catch (e) { res.status(e.status || 500).json({ error: e.message || 'Background creation failed.' }); }
});

/* Example cut-outs: downloaded from Unsplash by the server, processed once, then served from disk cache. */
const inflight = new Map();
async function buildExample(id) {
  const file = path.join(CACHE_DIR, id + '.png');
  if (fs.existsSync(file)) return file;
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    const r = await fetch('https://images.unsplash.com/photo-' + id + '?auto=format&fit=crop&w=1000&q=80');
    if (!r.ok) throw new AiError('The example photo could not be downloaded.', 502);
    const png = await removeBackground(Buffer.from(await r.arrayBuffer()));
    fs.writeFileSync(file, png);
    return file;
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}
app.get('/api/example-cutout/:id', rateLimit, async (req, res) => {
  const id = req.params.id;
  if (!EXAMPLE_IDS.has(id)) return res.status(404).json({ error: 'Unknown example.' });
  try {
    const file = await buildExample(id);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.status(e.status || 500).json({ error: e.message || 'Example could not be processed.' }); }
});

/* Static files: only the page and the examples folder are public (server.js, .env, cache are not). */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/examples', express.static(path.join(__dirname, 'examples')));

app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'The image is too large (max 12 MB).' });
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log('Pixelora running on http://localhost:' + PORT);
  if (!OPENAI_KEY) console.warn('WARNING: OPENAI_API_KEY is not set. AI tools will return an error until you add it to .env');
});
