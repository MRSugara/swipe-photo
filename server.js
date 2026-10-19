#!/usr/bin/env node
'use strict';

// Swipe Photo — pilih foto bagus dengan keyboard. Tanpa dependency.
// Jalankan: node server.js   (opsional: PORT=4321 HOST=127.0.0.1 NO_OPEN=1)

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
const DATA_DIR = path.join(os.homedir(), '.swipe-photo');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const DECISIONS_DIR = path.join(DATA_DIR, 'decisions');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
// Nama folder foto bagus yang dibuat di dalam folder foto kalau tujuan tidak diisi.
const GOOD_DIR = 'Bagus';

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};
const CONVERT_EXT = new Set(['.heic', '.heif']);
const RAW_EXT = new Set([
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.orf', '.rw2', '.rwl',
  '.dng', '.pef', '.srw', '.x3f', '.3fr', '.iiq', '.erf', '.kdc', '.mrw', '.mos',
]);
const SIDECAR_EXT = new Set(['.xmp']);
// sips (macOS) bisa mengubah HEIC & RAW ke JPEG. Di OS lain keduanya tidak bisa ditampilkan:
// HEIC dilewati, RAW hanya ikut dipindah sebagai pasangan JPEG-nya.
const CAN_CONVERT = IS_MAC;
const SHOW_EXT = new Set([...Object.keys(MIME), ...(CAN_CONVERT ? CONVERT_EXT : [])]);
const SCAN_EXT = new Set([...SHOW_EXT, ...RAW_EXT, ...SIDECAR_EXT]);
// Urutan pilihan foto utama kalau ada beberapa file bernama sama (IMG_1.jpg + IMG_1.heic).
const SHOW_PREF = ['.jpg', '.jpeg', '.heic', '.heif', '.png', '.webp', '.avif', '.gif', '.bmp'];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

let session = null; // { id, src, dst: { good }, decisions, companions }
const TARGETS = ['good'];

const fail = (status, message) => Object.assign(new Error(message), { status });
const extOf = (f) => path.extname(f).toLowerCase();
const isConvertible = (ext) => CAN_CONVERT && (CONVERT_EXT.has(ext) || RAW_EXT.has(ext));

function normalizePath(input) {
  let p = String(input || '').trim();
  if (/^(['"]).*\1$/.test(p)) p = p.slice(1, -1);
  if (!IS_WIN) p = p.replace(/\\(.)/g, '$1'); // path hasil drag ke Terminal: "My\ Photos"
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isPlainName(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && name === path.basename(name);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function openWithSystem(target) {
  if (IS_MAC) execFile('open', [target], () => {});
  else if (IS_WIN) execFile('cmd', ['/c', 'start', '', target], { windowsHide: true }, () => {});
  else execFile('xdg-open', [target], () => {});
}

// ---------- Pindai & kelompokkan foto ----------

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
    } else if (e.isFile() && SCAN_EXT.has(extOf(e.name))) {
      out.push(full);
    }
  }
  await Promise.all(subdirs.map((d) => scan(d, recursive, skipDirs, out)));
}

// Kunci pengelompokan: folder + nama tanpa ekstensi. "IMG_1.CR2.xmp" ikut kunci "IMG_1".
function groupKey(file) {
  let name = path.basename(file);
  let ext = extOf(name);
  if (SIDECAR_EXT.has(ext)) {
    name = name.slice(0, -ext.length);
    ext = extOf(name);
    if (!SHOW_EXT.has(ext) && !RAW_EXT.has(ext)) ext = '';
  }
  return path.join(path.dirname(file), ext ? name.slice(0, -ext.length) : name).toLowerCase();
}

// Foto yang bisa ditampilkan jadi foto utama; RAW / .xmp bernama sama jadi pendampingnya
// dan selalu dipindah bersama. RAW tanpa JPEG jadi foto utama kalau bisa dikonversi (macOS).
function groupPhotos(files) {
  const groups = new Map();
  for (const f of files) {
    const key = groupKey(f);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const mains = [];
  const companions = new Map();
  for (const group of groups.values()) {
    const shows = group.filter((f) => SHOW_EXT.has(extOf(f)));
    const raws = group.filter((f) => RAW_EXT.has(extOf(f)));
    const sides = group.filter((f) => SIDECAR_EXT.has(extOf(f)));
    let main;
    if (shows.length) {
      shows.sort((a, b) => SHOW_PREF.indexOf(extOf(a)) - SHOW_PREF.indexOf(extOf(b)));
      main = shows[0];
      mains.push(...shows);
    } else if (raws.length && CAN_CONVERT) {
      main = raws.shift();
      mains.push(main);
    } else {
      continue;
    }
    const extra = [...raws, ...sides];
    if (extra.length) companions.set(main, extra);
  }
  return { mains, companions };
}

async function scanPhotos(dir, recursive = false, skipDirs = new Set()) {
  const files = [];
  await scan(dir, recursive, skipDirs, files);
  return groupPhotos(files);
}

// ---------- Duplikat ----------
// Export Google Drive yang dipecah beberapa zip sering berisi salinan identik di
// beberapa folder. Foto yang isinya sama persis dengan foto di folder bagus
// dianggap sudah diseleksi, dan salinan ganda di folder sumber cukup tampil sekali.

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

async function dropDuplicates(files, sortedFiles) {
  const all = [...sortedFiles.map((f) => ({ f, done: true })), ...files.map((f) => ({ f, done: false }))];
  await Promise.all(all.map(async (x) => { x.size = (await fsp.stat(x.f).catch(() => null))?.size; }));

  // Hash hanya file yang ukurannya kembar, jadi folder besar tetap cepat dipindai.
  const bySize = new Map();
  for (const x of all) if (x.size !== undefined) bySize.set(x.size, (bySize.get(x.size) || 0) + 1);
  const twins = all.filter((x) => x.size !== undefined && bySize.get(x.size) > 1);
  const hashSlot = limiter(8);
  await Promise.all(twins.map((x) => hashSlot(async () => { x.hash = await hashFile(x.f).catch(() => null); })));
  const seen = new Set();
  const keep = [];
  for (const x of all) {
    if (x.hash) {
      const key = `${x.size}:${x.hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (!x.done) keep.push(x.f);
  }
  return keep;
}

// ---------- Proyek (daftar folder yang pernah disortir) ----------

function serializer() {
  let queue = Promise.resolve();
  return (fn) => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
}
const serialProjects = serializer();

async function loadProjects() {
  try {
    const list = JSON.parse(await fsp.readFile(PROJECTS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  await fsp.rename(tmp, file);
}

function updateProjects(fn) {
  return serialProjects(async () => writeJson(PROJECTS_FILE, fn(await loadProjects())));
}

// ---------- Pilihan per proyek ----------
// { "<path relatif asal>":
//     { status: "kept" }                                   dilewati
//   | { status: "good", name, extra?: [{ from, name }] }   di folder Bagus (+ RAW/.xmp pendamping)
//   | { status: "dup" } }                                  kembar dengan foto lain, tidak ditampilkan
// Supaya tanda bagus/dilewati tetap ada setelah proyek dibuka lagi, dan foto bagus
// bisa ditampilkan di urutan aslinya lalu dikembalikan kalau dipilih ulang.

const decisionsFile = (src) => path.join(DECISIONS_DIR, `${crypto.createHash('sha1').update(src).digest('hex')}.json`);

// null = belum pernah disimpan (proyek dari versi lama yang hanya mencatat posisi terakhir)
async function loadDecisions(src) {
  try {
    const d = JSON.parse(await fsp.readFile(decisionsFile(src), 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return null;
  }
}

// Versi lama hanya mencatat "seen" (foto terakhir yang dilihat): semua sebelum itu dianggap dilewati.
function migrateSeen(rel, seen) {
  const d = {};
  if (typeof seen === 'string') for (const f of rel) if (collator.compare(f, seen) <= 0) d[f] = { status: 'kept' };
  return d;
}

const serialDecisions = serializer();
let pendingSave = null; // { src, decisions } yang belum ditulis
let saveTimer;

function saveDecisionsSoon() {
  pendingSave = { src: session.src, decisions: session.decisions };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDecisions, 300);
}

function flushDecisions() {
  clearTimeout(saveTimer);
  const job = pendingSave;
  pendingSave = null;
  return job ? serialDecisions(() => writeJson(decisionsFile(job.src), job.decisions)) : serialDecisions(() => {});
}

// "Belum dilihat" = foto di folder sumber yang belum punya catatan (dilewati / kembar).
async function listProjects() {
  await flushDecisions();
  const list = await loadProjects();
  const projects = await Promise.all(
    list.map(async (p) => {
      const st = await fsp.stat(p.src).catch(() => null);
      if (!st || !st.isDirectory()) return { ...p, missing: true };
      const [source, good] = await Promise.all([
        scanPhotos(p.src, p.recursive, new Set([p.good])),
        scanPhotos(p.good),
      ]);
      const rel = source.mains.map((f) => path.relative(p.src, f));
      const decisions = (await loadDecisions(p.src)) || migrateSeen(rel, p.seen);
      let skipped = 0;
      let dup = 0;
      for (const f of rel) {
        const s = decisions[f]?.status;
        if (s === 'kept') skipped++;
        else if (s === 'dup') dup++;
      }
      return { ...p, count: { left: rel.length - skipped - dup, skipped, good: good.mains.length } };
    })
  );
  return { canOpen: IS_MAC || IS_WIN, home: os.homedir(), sep: path.sep, projects };
}

// Tandai foto di folder sumber sebagai dilewati (status "kept") atau hapus tandanya (null).
// Status "good" dicatat oleh moveOne/undoOne.
async function markOne({ s, f, status }) {
  checkSession(s);
  inSrc(f);
  if (status === 'kept') session.decisions[f] = { status: 'kept' };
  else if (status === null) {
    if (session.decisions[f]?.status === 'kept') delete session.decisions[f];
  } else throw fail(400, 'Status tidak valid');
  saveDecisionsSoon();
  return { ok: true };
}

// Hapus dari daftar beserta catatan pilihannya. Foto & folder tidak disentuh.
async function forgetProject({ src }) {
  await updateProjects((list) => list.filter((p) => p.src !== src));
  if (typeof src === 'string' && src) {
    await flushDecisions();
    await fsp.unlink(decisionsFile(src)).catch(() => {});
  }
  return { ok: true };
}

async function openFolder({ src, which }) {
  if (!IS_MAC && !IS_WIN) throw fail(501, 'Buka folder hanya tersedia di macOS dan Windows');
  const p = (await loadProjects()).find((x) => x.src === src);
  if (!p) throw fail(404, 'Proyek tidak ditemukan');
  const dir = { src: p.src, good: p.good }[which];
  if (!dir) throw fail(400, 'Folder tidak valid');
  if (!(await exists(dir))) throw fail(404, `Folder belum ada: ${dir}`);
  if (IS_WIN) execFile('explorer.exe', [dir], { windowsHide: true }, () => {});
  else execFile('open', [dir], () => {});
  return { ok: true };
}

// ---------- Pilih folder ----------
// Jendela "pilih folder" bawaan sistem (Finder di macOS, Explorer di Windows). Dibuka di folder
// induk proyek terakhir (biasanya tempat Project A, B, C berada), atau di folder Gambar.
let pickChild = null;
let picking = null;

function pickCommand(start) {
  if (IS_MAC) {
    const script = [
      'on run argv',
      'activate',
      'return POSIX path of (choose folder with prompt "Pilih folder foto" default location (POSIX file (item 1 of argv)))',
      'end run',
    ];
    return { cmd: 'osascript', args: [...script.flatMap((line) => ['-e', line]), start], opts: {} };
  }
  // Form TopMost sebagai pemilik supaya dialog muncul di depan browser. Dikirim sebagai
  // -EncodedCommand (UTF-16LE base64) supaya tanda kutip tidak rusak di baris perintah Windows.
  const ps = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Pilih folder foto'",
    '$d.SelectedPath = $env:SP_START',
    'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
  ].join('; ');
  return {
    cmd: 'powershell.exe',
    args: ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
    opts: { windowsHide: true, env: { ...process.env, SP_START: start } },
  };
}

async function pickFolder() {
  if (!IS_MAC && !IS_WIN) throw fail(501, 'Jendela pilih folder hanya tersedia di macOS dan Windows');
  if (picking) return picking;
  const last = (await loadProjects())[0];
  const candidates = [last && path.dirname(last.src), path.join(os.homedir(), 'Pictures'), os.homedir()];
  let start = os.homedir();
  for (const c of candidates) if (c && (await exists(c))) { start = c; break; }
  const { cmd, args, opts } = pickCommand(start);
  picking = new Promise((resolve, reject) => {
    pickChild = execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (!err) return resolve({ path: stdout.trim() || null }); // Windows: kosong = dibatalkan
      if (err.killed || /-128/.test(stderr)) return resolve({ path: null }); // dibatalkan
      reject(fail(500, `Jendela pilih folder gagal dibuka: ${stderr.trim() || err.message}`));
    });
  }).finally(() => {
    picking = null;
    pickChild = null;
  });
  return picking;
}

function cancelPick() {
  if (pickChild) pickChild.kill();
  return { ok: true };
}

// Cadangan kalau jendela sistem tidak bisa dipakai (dibuka dari HP, atau gagal):
// daftar folder di dalam halaman.
async function places() {
  const home = os.homedir();
  const list = [
    { name: 'Home', path: home },
    { name: 'Gambar', path: path.join(home, 'Pictures') },
    { name: 'Desktop', path: path.join(home, 'Desktop') },
    { name: 'Unduhan', path: path.join(home, 'Downloads') },
    { name: 'Dokumen', path: path.join(home, 'Documents') },
  ];
  if (IS_WIN) {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') list.push({ name: `${letter}:`, path: `${letter}:\\`, drive: true });
  } else {
    // Hardisk eksternal; "Macintosh HD" di /Volumes berupa symlink ke / jadi tidak ikut.
    const vols = await fsp.readdir('/Volumes', { withFileTypes: true }).catch(() => []);
    for (const v of vols) {
      if (v.isDirectory() && !v.name.startsWith('.')) list.push({ name: v.name, path: path.join('/Volumes', v.name), drive: true });
    }
  }
  const ok = await Promise.all(list.map((p) => exists(p.path)));
  return list.filter((_, i) => ok[i]);
}

async function browse(input) {
  const pictures = path.join(os.homedir(), 'Pictures');
  const dir = input ? normalizePath(input) : (await exists(pictures)) ? pictures : os.homedir();
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const hint = IS_MAC && (err.code === 'EPERM' || err.code === 'EACCES')
      ? ' Beri izin di System Settings → Privacy & Security → Files and Folders.'
      : '';
    throw fail(400, `Folder tidak bisa dibuka: ${dir}.${hint}`);
  }
  const dirs = [];
  let photos = 0;
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('$') || e.name === 'System Volume Information') continue;
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile() && (SHOW_EXT.has(extOf(e.name)) || isConvertible(extOf(e.name)))) photos++;
  }
  dirs.sort(collator.compare);
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    dirs: dirs.map((name) => ({ name, path: path.join(dir, name) })),
    photos,
    places: await places(),
  };
}

// ---------- Session ----------

// good/recursive boleh kosong: pakai pengaturan proyek sebelumnya, atau
// folder "Bagus" di dalam folder foto.
async function start({ src, good, recursive }) {
  if (!src) throw fail(400, 'Pilih folder foto dulu');
  const s = normalizePath(src);
  const st = await fsp.stat(s).catch(() => null);
  if (!st || !st.isDirectory()) throw fail(400, `Folder foto tidak ditemukan: ${s}`);
  const prev = (await loadProjects()).find((p) => p.src === s);
  const dst = { good: good ? normalizePath(good) : prev?.good || path.join(s, GOOD_DIR) };
  const rec = recursive === undefined ? prev?.recursive ?? true : !!recursive;
  if (s === dst.good) throw fail(400, 'Folder foto bagus tidak boleh sama dengan folder foto');
  await Promise.all(TARGETS.map((t) => fsp.mkdir(dst[t], { recursive: true })));

  const relOf = (f) => path.relative(s, f);
  const [source, goodScan] = await Promise.all([scanPhotos(s, rec, new Set([dst.good])), scanPhotos(dst.good)]);
  source.mains.sort((a, b) => collator.compare(relOf(a), relOf(b)));
  const files = await dropDuplicates(source.mains, goodScan.mains);
  const keptFiles = new Set(files);
  const rel = files.map(relOf);
  const companions = new Map();
  for (const f of files) if (source.companions.has(f)) companions.set(relOf(f), source.companions.get(f));

  // Gabungkan foto di folder sumber dengan foto bagus yang tercatat (masih ada di folder Bagus),
  // diurutkan menurut path aslinya. Catatan yang sudah tidak cocok dengan isi folder dibuang.
  await flushDecisions();
  const decisions = (await loadDecisions(s)) || migrateSeen(rel, prev?.seen);
  const inSource = new Set(rel);
  const inGood = new Set((await fsp.readdir(dst.good).catch(() => [])));
  const list = rel.map((f) => ({
    f,
    status: decisions[f]?.status === 'kept' ? 'kept' : null,
    extra: companions.get(f)?.length || 0,
  }));
  for (const [f, d] of Object.entries(decisions)) {
    if (d.status === 'good' && !inSource.has(f) && isPlainName(d.name) && inGood.has(d.name)) {
      d.extra = (d.extra || []).filter((e) => isPlainName(e.from) && isPlainName(e.name) && inGood.has(e.name));
      if (!d.extra.length) delete d.extra;
      list.push({ f, status: 'good', name: d.name, extra: d.extra?.length || 0 });
    } else if (!(d.status === 'kept' && inSource.has(f))) {
      delete decisions[f];
    }
  }
  for (const f of source.mains) if (!keptFiles.has(f)) decisions[relOf(f)] = { status: 'dup' };

  // Foto di folder Bagus yang belum tercatat (mis. dipindah oleh versi lama): asalnya tidak
  // diketahui, jadi dianggap dari folder utama proyek.
  const tracked = new Set(Object.values(decisions).map((d) => d.name));
  for (const main of goodScan.mains) {
    const name = path.basename(main);
    if (tracked.has(name) || inSource.has(name) || decisions[name]) continue;
    const extra = (goodScan.companions.get(main) || []).map((e) => ({ from: path.basename(e), name: path.basename(e) }));
    decisions[name] = { status: 'good', name, ...(extra.length && { extra }) };
    list.push({ f: name, status: 'good', name, extra: extra.length });
  }
  list.sort((a, b) => collator.compare(a.f, b.f));

  const name = path.basename(s) || s;
  await updateProjects((projects) => [
    { name, src: s, good: dst.good, recursive: rec, openedAt: Date.now() },
    ...projects.filter((p) => p.src !== s),
  ]);

  session = { id: crypto.randomBytes(4).toString('hex'), src: s, dst, decisions, companions };
  saveDecisionsSoon();
  return {
    id: session.id,
    name,
    src: s,
    dst,
    recursive: rec,
    canZoomConvert: CAN_CONVERT,
    files: list,
    duplicates: source.mains.length - files.length,
  };
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

const serial = serializer();

// Nama tujuan untuk foto utama + pendampingnya dengan nama dasar yang sama:
// IMG_1.jpg + IMG_1.CR2 → "IMG_1 (1).jpg" + "IMG_1 (1).CR2" kalau yang pertama sudah ada.
async function uniqueTargets(dir, main, extras) {
  const ext = path.extname(main);
  const base = path.basename(main, ext);
  const suffix = (e) => {
    const n = path.basename(e);
    return n.toLowerCase().startsWith(base.toLowerCase()) ? n.slice(base.length) : path.extname(n);
  };
  for (let i = 0; ; i++) {
    const b = i ? `${base} (${i})` : base;
    const targets = [b + ext, ...extras.map((e) => b + suffix(e))].map((n) => path.join(dir, n));
    if (!(await Promise.all(targets.map(exists))).some(Boolean)) return targets;
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
  if (!TARGETS.includes(to)) throw fail(400, 'Tujuan harus "good"');
  return session.dst[to];
}

async function moveOne({ s, f, to }) {
  checkSession(s);
  const from = inSrc(f);
  const extras = session.companions.get(f) || [];
  const [target, ...extraTargets] = await uniqueTargets(targetDir(to), from, extras);
  await moveFile(from, target);
  const moved = [];
  for (let i = 0; i < extras.length; i++) {
    try {
      await moveFile(extras[i], extraTargets[i]);
      moved.push({ from: path.basename(extras[i]), name: path.basename(extraTargets[i]) });
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Gagal memindah pendamping ${extras[i]}: ${err.message}`);
    }
  }
  session.companions.delete(f);
  const name = path.basename(target);
  session.decisions[f] = { status: 'good', name, ...(moved.length && { extra: moved }) };
  saveDecisionsSoon();
  return { name };
}

async function undoOne({ s, f, name, to }) {
  checkSession(s);
  const back = inSrc(f);
  const dir = targetDir(to);
  if (!isPlainName(name)) throw fail(400, 'Nama file tidak valid');
  if (await exists(back)) throw fail(409, `File asal sudah ada: ${f}`);
  const d = session.decisions[f];
  const extras = d?.status === 'good' && d.name === name ? d.extra || [] : [];
  await fsp.mkdir(path.dirname(back), { recursive: true });
  await moveFile(path.join(dir, name), back);
  const restored = [];
  for (const e of extras) {
    if (!isPlainName(e.from) || !isPlainName(e.name)) continue;
    const dest = path.join(path.dirname(back), e.from);
    if (await exists(dest)) continue;
    try {
      await moveFile(path.join(dir, e.name), dest);
      restored.push(dest);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Gagal mengembalikan pendamping ${e.name}: ${err.message}`);
    }
  }
  if (restored.length) session.companions.set(f, restored);
  delete session.decisions[f];
  saveDecisionsSoon();
  return { ok: true };
}

// ---------- Konversi ke JPEG via sips (HEIC, RAW, thumbnail), di-cache, paralel terbatas ----------

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
const cpus = os.cpus().length;
const FULL = { size: 2560, quality: 85, slot: limiter(Math.max(2, cpus - 2)) };
const ZOOM = { size: 0, quality: 92, slot: FULL.slot }; // ukuran asli untuk zoom 100%
const THUMB = { size: 360, quality: 70, slot: limiter(Math.max(2, Math.floor(cpus / 3))) };
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
        const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), ...(size ? ['-Z', String(size)] : []), file, '--out', tmp];
        execFile('sips', args, (err) => {
          if (err) return reject(fail(415, `Gagal konversi gambar: ${err.message}`));
          fsp.rename(tmp, out).then(() => resolve(out), reject);
        });
      })
  ).finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

// ---------- Info foto (EXIF) ----------
// Pembaca EXIF kecil untuk JPEG: tanggal ambil, kamera, setelan, ukuran. HEIC/RAW lewat sips.
// Dipakai untuk info di bawah foto dan untuk mengelompokkan foto beruntun (burst).

function exifDate(s, sub) {
  const m = /^(\d{4}):(\d\d):(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s || '');
  if (!m) return undefined;
  const ms = sub ? Math.round(Number(`0.${String(sub).replace(/\D/g, '')}`) * 1000) || 0 : 0;
  const t = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
  return Number.isFinite(t) && +m[1] > 1970 ? t : undefined;
}

function parseTiff(buf, start, end, m) {
  if (start + 8 > end) return;
  const le = buf[start] === 0x49; // "II" little endian, "MM" big endian
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const value = (e) => {
    const type = u16(e + 2);
    const count = u32(e + 4);
    const size = (SIZE[type] || 0) * count;
    if (!size) return undefined;
    const at = size > 4 ? start + u32(e + 8) : e + 8;
    if (at + size > end) return undefined;
    if (type === 2) return buf.toString('latin1', at, at + count).replace(/\0[\s\S]*$/, '').trim();
    if (type === 3) return u16(at);
    if (type === 4 || type === 9) return u32(at);
    if (type === 5 || type === 10) {
      const den = u32(at + 4);
      return den ? u32(at) / den : undefined;
    }
    return undefined;
  };
  const ifd = (offset, want) => {
    const out = {};
    const o = start + offset;
    if (offset < 8 || o + 2 > end) return out;
    const n = u16(o);
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      if (e + 12 > end) break;
      const name = want[u16(e)];
      if (name) out[name] = value(e);
    }
    return out;
  };
  const a = ifd(u32(start + 4), { 0x010f: 'make', 0x0110: 'model', 0x0112: 'orient', 0x0132: 'dt', 0x8769: 'exif' });
  const b = a.exif ? ifd(a.exif, {
    0x9003: 'dto', 0x9291: 'sub', 0x829a: 'exp', 0x829d: 'fn', 0x8827: 'iso', 0x920a: 'fl', 0xa002: 'pw', 0xa003: 'ph',
  }) : {};
  m.t = exifDate(b.dto, b.sub) ?? exifDate(a.dt);
  m.make = a.make;
  m.model = a.model;
  m.orient = a.orient;
  m.exp = b.exp;
  m.fn = b.fn;
  m.iso = b.iso;
  m.fl = b.fl;
  m.ew = b.pw;
  m.eh = b.ph;
}

function parseJpeg(buf) {
  const m = {};
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return m;
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break;
    const marker = buf[off + 1];
    if (marker === 0xff) { off++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    // Hanya blok EXIF pertama: sebagian aplikasi menambah blok kedua tanpa tanggal ambil.
    if (marker === 0xe1 && !m.exifRead && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
      m.exifRead = true;
      parseTiff(buf, off + 10, Math.min(buf.length, off + 2 + len), m);
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (off + 9 <= buf.length) {
        m.h = buf.readUInt16BE(off + 5);
        m.w = buf.readUInt16BE(off + 7);
      }
      break;
    } else if (marker === 0xda) break;
    off += 2 + len;
  }
  return m;
}

async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function sipsMeta(file) {
  return new Promise((resolve) => {
    execFile('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'creation', '-g', 'make', '-g', 'model', file], (err, out) => {
      if (err) return resolve({});
      const get = (k) => {
        const v = new RegExp(`^\\s*${k}: (.+)$`, 'm').exec(out)?.[1]?.trim();
        return v && v !== '<nil>' ? v : undefined; // sips menulis <nil> kalau datanya tidak ada
      };
      resolve({
        w: Number(get('pixelWidth')) || undefined,
        h: Number(get('pixelHeight')) || undefined,
        t: exifDate(get('creation')),
        make: get('make'),
        model: get('model'),
      });
    });
  });
}

async function readMeta(file, st) {
  const ext = extOf(file);
  let m = {};
  try {
    if (ext === '.jpg' || ext === '.jpeg') m = parseJpeg(await readHead(file, 256 * 1024));
    else if (ext === '.png') {
      const b = await readHead(file, 24);
      if (b.length >= 24 && b.readUInt32BE(12) === 0x49484452) m = { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    } else if (isConvertible(ext)) m = await sipsMeta(file);
  } catch {
    m = {};
  }
  let w = m.w || m.ew;
  let h = m.h || m.eh;
  if (m.orient >= 5 && m.orient <= 8) [w, h] = [h, w];
  const make = (m.make || '').trim();
  let model = (m.model || '').trim();
  if (make && !model.toLowerCase().startsWith(make.split(' ')[0].toLowerCase())) model = `${make} ${model}`.trim();
  return {
    t: m.t ?? Math.round(st.mtimeMs),
    exact: m.t !== undefined, // false = tanggal dari file, bukan dari kamera
    w,
    h,
    size: st.size,
    cam: model || undefined,
    iso: m.iso,
    fn: m.fn,
    exp: m.exp,
    fl: m.fl,
  };
}

const metaCache = new Map();
const metaSlot = limiter(8);

async function metaOf(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) return null;
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (!metaCache.has(key)) {
    if (metaCache.size > 50000) metaCache.clear();
    metaCache.set(key, metaSlot(() => readMeta(file, st)));
  }
  return metaCache.get(key);
}

async function metaBatch({ s, items }) {
  checkSession(s);
  if (!Array.isArray(items) || items.length > 300) throw fail(400, 'Daftar foto tidak valid');
  return Promise.all(items.map((it) => metaOf(resolveRef(it?.g ? { g: it.g } : { f: it?.f })).catch(() => null)));
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

// f = path relatif di folder sumber, g = nama file yang sudah dipindah ke folder Bagus
// (supaya foto bagus tetap bisa dilihat lagi waktu memilih ulang).
function resolveRef({ f, g }) {
  if (!g) return inSrc(f);
  if (!isPlainName(g)) throw fail(400, 'Nama file tidak valid');
  return path.join(session.dst.good, g);
}

// mode: 'full' (tampilan biasa), 'thumb' (strip), 'zoom' (ukuran asli untuk zoom 100%)
async function serveImage(req, res, params, mode) {
  checkSession(params.get('s'));
  const file = resolveRef({ f: params.get('f'), g: params.get('g') });
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw fail(404, 'File tidak ditemukan');

  const ext = extOf(file);
  const convert = isConvertible(ext) || (mode === 'thumb' && CAN_CONVERT);
  const opts = mode === 'thumb' ? THUMB : mode === 'zoom' ? ZOOM : FULL;
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${convert ? `-${opts.size}` : ''}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }

  let out = file;
  let type = MIME[ext];
  let size = st.size;
  if (convert) {
    out = await toJpeg(file, st, opts);
    type = 'image/jpeg';
    size = (await fsp.stat(out)).size;
  } else if (!type) {
    throw fail(415, 'Format foto ini tidak bisa ditampilkan di sistem ini');
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
  const post = req.method === 'POST';
  try {
    if (req.method === 'GET') {
      if (url.pathname === '/') return await serveIndex(res);
      if (url.pathname === '/img') return await serveImage(req, res, url.searchParams, url.searchParams.get('z') ? 'zoom' : 'full');
      if (url.pathname === '/thumb') return await serveImage(req, res, url.searchParams, 'thumb');
      if (url.pathname === '/api/projects') return json(res, 200, await listProjects());
      if (url.pathname === '/api/browse') return json(res, 200, await browse(url.searchParams.get('path')));
    }
    if (post) {
      if (url.pathname === '/api/pick') return json(res, 200, await pickFolder());
      if (url.pathname === '/api/pick-cancel') return json(res, 200, cancelPick());
      const body = await readJson(req);
      if (url.pathname === '/api/start') return json(res, 200, await start(body));
      if (url.pathname === '/api/meta') return json(res, 200, await metaBatch(body));
      if (url.pathname === '/api/move') return json(res, 200, await serial(() => moveOne(body)));
      if (url.pathname === '/api/undo') return json(res, 200, await serial(() => undoOne(body)));
      if (url.pathname === '/api/mark') return json(res, 200, await serial(() => markOne(body)));
      if (url.pathname === '/api/forget') return json(res, 200, await forgetProject(body));
      if (url.pathname === '/api/open') return json(res, 200, await openFolder(body));
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!err.status) console.error(err);
    if (res.headersSent) return res.destroy();
    json(res, err.status || 500, { error: err.message });
  }
});

fs.mkdirSync(CACHE_DIR, { recursive: true });

const appUrl = `http://localhost:${PORT}`;

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  // Diklik dua kali lagi saat sudah jalan: cukup buka browser ke yang sudah ada.
  http
    .get(`http://127.0.0.1:${PORT}/api/projects`, (res) => {
      res.resume();
      if (res.statusCode !== 200) return portBusy();
      console.log(`Swipe Photo sudah berjalan di ${appUrl}`);
      if (!process.env.NO_OPEN) openWithSystem(appUrl);
      setTimeout(() => process.exit(0), 300);
    })
    .on('error', portBusy);
});

function portBusy() {
  console.error(`Port ${PORT} sudah dipakai aplikasi lain. Coba: PORT=4322 node server.js`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`Swipe Photo jalan di ${appUrl}  (Ctrl+C untuk berhenti)`);
  if (HOST === '0.0.0.0') {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  jaringan: http://${a.address}:${PORT}`);
      }
    }
  }
  if (!process.env.NO_OPEN) openWithSystem(appUrl);
});
