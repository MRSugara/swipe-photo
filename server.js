#!/usr/bin/env node
'use strict';

// Swipe Photo — sortir foto lokal dengan keyboard. Tanpa dependency.
// Jalankan: node server.js   (opsional: PORT=4321 NO_OPEN=1)

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '0.0.0.0';
const INDEX = path.join(__dirname, 'public', 'index.html');
const CACHE_DIR = path.join(os.tmpdir(), 'swipe-photo-cache');

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};
const CONVERT = new Set(['.heic', '.heif']);
const IMAGE_EXT = new Set([...Object.keys(MIME), ...CONVERT]);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

let session = null; // { id, src, dst: { good, bad } }
const TARGETS = ['good', 'bad'];

const fail = (status, message) => Object.assign(new Error(message), { status });

function normalizePath(input) {
  let p = String(input || '').trim();
  if (/^(['"]).*\1$/.test(p)) p = p.slice(1, -1);
  p = p.replace(/\\(.)/g, '$1'); // path hasil drag ke Terminal: "My\ Photos"
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function scan(dir, recursive, skipDirs, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive && !skipDirs.has(full)) subdirs.push(full);
    } else if (e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
      out.push(full);
    }
  }
  await Promise.all(subdirs.map((d) => scan(d, recursive, skipDirs, out)));
}

// ---------- Duplikat ----------
// Export Google Drive yang dipecah beberapa zip sering berisi salinan identik di
// beberapa folder. Foto yang isinya sama persis dengan foto di folder bagus/jelek
// dianggap sudah diseleksi, dan salinan ganda di folder sumber cukup tampil sekali.

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

async function dropDuplicates(files, sortedDirs) {
  const sorted = [];
  for (const dir of sortedDirs) await scan(dir, false, new Set(), sorted);
  const all = [...sorted.map((f) => ({ f, done: true })), ...files.map((f) => ({ f, done: false }))];
  await Promise.all(all.map(async (x) => { x.size = (await fsp.stat(x.f).catch(() => null))?.size; }));

  // Hash hanya file yang ukurannya kembar, jadi folder besar tetap cepat dipindai.
  const bySize = new Map();
  for (const x of all) if (x.size !== undefined) bySize.set(x.size, (bySize.get(x.size) || 0) + 1);
  const seen = new Set();
  const keep = [];
  for (const x of all) {
    if (x.size !== undefined && bySize.get(x.size) > 1) {
      const key = `${x.size}:${await hashFile(x.f)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (!x.done) keep.push(x.f);
  }
  return keep;
}

// ---------- Session ----------

async function start({ src, good, bad, recursive }) {
  if (!src || !good || !bad) throw fail(400, 'Folder sumber, folder bagus, dan folder jelek wajib diisi');
  const s = normalizePath(src);
  const dst = { good: normalizePath(good), bad: normalizePath(bad) };
  const st = await fsp.stat(s).catch(() => null);
  if (!st || !st.isDirectory()) throw fail(400, `Folder sumber tidak ditemukan: ${s}`);
  if (s === dst.good || s === dst.bad) throw fail(400, 'Folder tujuan tidak boleh sama dengan folder sumber');
  if (dst.good === dst.bad) throw fail(400, 'Folder bagus dan folder jelek tidak boleh sama');
  await Promise.all(TARGETS.map((t) => fsp.mkdir(dst[t], { recursive: true })));

  const found = [];
  await scan(s, !!recursive, new Set(Object.values(dst)), found);
  found.sort((a, b) => collator.compare(path.relative(s, a), path.relative(s, b)));
  const files = await dropDuplicates(found, Object.values(dst));
  const rel = files.map((f) => path.relative(s, f));

  session = { id: crypto.randomBytes(4).toString('hex'), src: s, dst };
  return { id: session.id, src: s, dst, files: rel, duplicates: found.length - files.length };
}

function checkSession(id) {
  if (!session) throw fail(409, 'Belum ada sesi aktif');
  if (id !== session.id) throw fail(410, 'Sesi sudah berganti');
}

function inSrc(rel) {
  if (typeof rel !== 'string' || !rel) throw fail(400, 'Path kosong');
  const full = path.resolve(session.src, rel);
  if (!isInside(full, session.src)) throw fail(403, 'Path di luar folder sumber');
  return full;
}

// ---------- Move / undo (diserialisasi supaya nama unik tidak bentrok) ----------

let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

async function uniqueTarget(dir, name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i ? `${base} (${i})${ext}` : name);
    if (!(await exists(candidate))) return candidate;
  }
}

async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Beda disk: copy lalu hapus, pertahankan timestamp.
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    const st = await fsp.stat(from);
    await fsp.utimes(to, st.atime, st.mtime);
    await fsp.unlink(from);
  }
}

function targetDir(to) {
  if (!TARGETS.includes(to)) throw fail(400, 'Tujuan harus "good" atau "bad"');
  return session.dst[to];
}

async function moveOne({ s, f, to }) {
  checkSession(s);
  const from = inSrc(f);
  const target = await uniqueTarget(targetDir(to), path.basename(from));
  await moveFile(from, target);
  return { name: path.basename(target) };
}

async function undoOne({ s, f, name, to }) {
  checkSession(s);
  const back = inSrc(f);
  const dir = targetDir(to);
  if (typeof name !== 'string' || !name || name === '..' || name !== path.basename(name)) {
    throw fail(400, 'Nama file tidak valid');
  }
  if (await exists(back)) throw fail(409, `File asal sudah ada: ${f}`);
  await fsp.mkdir(path.dirname(back), { recursive: true });
  await moveFile(path.join(dir, name), back);
  return { ok: true };
}

// ---------- Konversi ke JPEG via sips (HEIC + thumbnail), di-cache, paralel terbatas ----------

function limiter(max) {
  let active = 0;
  const waiters = [];
  return async (fn) => {
    if (active >= max) await new Promise((resolve) => waiters.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = waiters.shift();
      if (next) next();
    }
  };
}

// Antrian terpisah supaya thumbnail tidak memperlambat foto utama.
const FULL = { size: 2560, quality: 85, slot: limiter(Math.max(2, os.cpus().length - 2)) };
const THUMB = { size: 360, quality: 70, slot: limiter(Math.max(2, Math.floor(os.cpus().length / 3))) };
const inflight = new Map();

async function toJpeg(file, st, { size, quality, slot }) {
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}|${size}`).digest('hex');
  const out = path.join(CACHE_DIR, `${key}.jpg`);
  if (await exists(out)) return out;
  if (inflight.has(key)) return inflight.get(key);

  const job = slot(
    () =>
      new Promise((resolve, reject) => {
        const tmp = path.join(CACHE_DIR, `${key}.${process.pid}.tmp.jpg`);
        const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), '-Z', String(size), file, '--out', tmp];
        execFile('sips', args, (err) => {
          if (err) return reject(fail(415, `Gagal konversi gambar: ${err.message}`));
          fsp.rename(tmp, out).then(() => resolve(out), reject);
        });
      })
  ).finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

// ---------- HTTP ----------

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(fail(413, 'Body terlalu besar'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(fail(400, 'JSON tidak valid'));
      }
    });
    req.on('error', reject);
  });
}

async function serveIndex(res) {
  const html = await fsp.readFile(INDEX);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

async function serveImage(req, res, params, thumb) {
  checkSession(params.get('s'));
  const file = inSrc(params.get('f'));
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw fail(404, 'File tidak ditemukan');

  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }

  const ext = path.extname(file).toLowerCase();
  let out = file;
  let type = MIME[ext];
  let size = st.size;
  if (thumb || CONVERT.has(ext)) {
    out = await toJpeg(file, st, thumb ? THUMB : FULL);
    type = 'image/jpeg';
    size = (await fsp.stat(out)).size;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Cache-Control': 'private, max-age=86400',
    ETag: etag,
  });
  fs.createReadStream(out).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') return await serveIndex(res);
    if (req.method === 'GET' && url.pathname === '/img') return await serveImage(req, res, url.searchParams, false);
    if (req.method === 'GET' && url.pathname === '/thumb') return await serveImage(req, res, url.searchParams, true);
    if (req.method === 'POST' && url.pathname === '/api/start') {
      return json(res, 200, await start(await readJson(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/move') {
      const body = await readJson(req);
      return json(res, 200, await serial(() => moveOne(body)));
    }
    if (req.method === 'POST' && url.pathname === '/api/undo') {
      const body = await readJson(req);
      return json(res, 200, await serial(() => undoOne(body)));
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!err.status) console.error(err);
    if (res.headersSent) return res.destroy();
    json(res, err.status || 500, { error: err.message });
  }
});

fs.mkdirSync(CACHE_DIR, { recursive: true });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} sudah dipakai. Coba: PORT=4322 node server.js`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Swipe Photo jalan di ${url}  (Ctrl+C untuk berhenti)`);
  if (HOST === '0.0.0.0') {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  jaringan: http://${a.address}:${PORT}`);
      }
    }
  }
  if (process.platform === 'darwin' && !process.env.NO_OPEN) execFile('open', [url], () => {});
});
