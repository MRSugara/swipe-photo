'use strict';

// Tes alur utama lewat HTTP, dengan HOME sementara supaya ~/.swipe-photo asli tidak tersentuh.
// Jalankan: node --test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PORT = 40000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swipe-photo-test-'));
const home = path.join(tmp, 'home');
const proj = path.join(home, 'Pictures', 'Project A');
const good = path.join(proj, 'Bagus');
const env = { ...process.env, HOME: home, USERPROFILE: home, PORT: String(PORT), HOST: '127.0.0.1', NO_OPEN: '1' };
let server;

// JPEG minimal: SOI + APP1 (EXIF DateTimeOriginal) + SOF0 (ukuran) + data acak + EOI.
function jpeg({ date = '2024:05:01 12:30:45', w = 640, h = 480 } = {}) {
  const tiff = Buffer.alloc(64);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8); // IFD0: 1 entri → pointer Exif IFD
  tiff.writeUInt16BE(0x8769, 10);
  tiff.writeUInt16BE(4, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt32BE(26, 18);
  tiff.writeUInt16BE(1, 26); // Exif IFD: DateTimeOriginal
  tiff.writeUInt16BE(0x9003, 28);
  tiff.writeUInt16BE(2, 30);
  tiff.writeUInt32BE(20, 32);
  tiff.writeUInt32BE(44, 36);
  tiff.write(`${date}\0`, 44, 'latin1');
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16(app1Body.length + 2), app1Body]);
  const sof = Buffer.concat([Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), u16(h), u16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, crypto.randomBytes(256), Buffer.from([0xff, 0xd9])]);
}
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

const write = (rel, data = crypto.randomBytes(128)) => {
  const f = path.join(proj, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  return data;
};
const has = (dir, name) => fs.existsSync(path.join(dir, name));

async function api(url, body) {
  const r = await fetch(BASE + url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const start = async () => (await api('/api/start', { src: proj })).data;
const byName = (files) => Object.fromEntries(files.map((x) => [x.f, x]));
const projectCard = async () => (await api('/api/projects')).data.projects.find((p) => p.src === proj);

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('jalan di')) resolve(child);
    });
    child.stderr.on('data', (c) => { out += c; });
    child.on('exit', (code) => reject(new Error(`server berhenti (${code}): ${out}`)));
  });
}

before(async () => {
  write('IMG_1.jpg', jpeg());
  write('IMG_1.CR2');
  write('IMG_1.CR2.xmp');
  write('IMG_2.jpg');
  write('IMG_2.CR2');
  write('IMG_3.jpg');
  const twin = write('IMG_4.jpg');
  write('sub/IMG_4 copy.jpg', twin); // isi sama persis → kembar
  write('IMG_5.png');
  write('notes.txt');
  // Sudah ada di folder Bagus dengan nama yang sama → hasil pindah harus jadi "IMG_2 (1)"
  fs.mkdirSync(good, { recursive: true });
  fs.writeFileSync(path.join(good, 'IMG_2.jpg'), crypto.randomBytes(100));
  fs.writeFileSync(path.join(good, 'IMG_2.CR2'), crypto.randomBytes(100));
  server = await startServer();
});

after(() => {
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('start: Bagus dibuat, RAW/XMP jadi pendamping, kembar & file lain dilewati', async () => {
  const r = await start();
  assert.ok(fs.statSync(good).isDirectory());
  const files = byName(r.files);
  assert.equal(files['IMG_1.jpg'].extra, 2);
  assert.equal(files['IMG_2.jpg'].extra, 1);
  assert.equal(files['IMG_1.CR2'], undefined);
  assert.equal(files['notes.txt'], undefined);
  assert.equal(r.duplicates, 1);
  assert.equal(Object.keys(files).filter((f) => f.includes('IMG_4')).length, 1);
  // Foto lama di folder Bagus (belum tercatat) ikut tampil sebagai bagus, kecuali yang bentrok
  // dengan nama di folder sumber.
  assert.equal(r.files.filter((x) => x.status === 'good').length, 0);
});

test('pindah ke Bagus membawa RAW/XMP, tercatat, dan bisa dikembalikan', async () => {
  let r = await start();
  const move = await api('/api/move', { s: r.id, f: 'IMG_1.jpg', to: 'good' });
  assert.equal(move.status, 200);
  assert.equal(move.data.name, 'IMG_1.jpg');
  for (const n of ['IMG_1.jpg', 'IMG_1.CR2', 'IMG_1.CR2.xmp']) {
    assert.ok(has(good, n), `${n} di Bagus`);
    assert.ok(!has(proj, n), `${n} tidak lagi di sumber`);
  }

  r = await start(); // dibuka lagi: tanda bagus tetap ada
  const it = byName(r.files)['IMG_1.jpg'];
  assert.equal(it.status, 'good');
  assert.equal(it.name, 'IMG_1.jpg');
  assert.equal(it.extra, 2);

  const undo = await api('/api/undo', { s: r.id, f: 'IMG_1.jpg', name: 'IMG_1.jpg', to: 'good' });
  assert.equal(undo.status, 200);
  for (const n of ['IMG_1.jpg', 'IMG_1.CR2', 'IMG_1.CR2.xmp']) assert.ok(has(proj, n), `${n} kembali`);

  // Setelah dikembalikan, pendamping tetap ikut kalau dipilih bagus lagi di sesi yang sama.
  await api('/api/move', { s: r.id, f: 'IMG_1.jpg', to: 'good' });
  assert.ok(has(good, 'IMG_1.CR2'));
  await api('/api/undo', { s: r.id, f: 'IMG_1.jpg', name: 'IMG_1.jpg', to: 'good' });
});

test('nama bentrok di Bagus: foto + RAW mendapat akhiran yang sama', async () => {
  const r = await start();
  const move = await api('/api/move', { s: r.id, f: 'IMG_2.jpg', to: 'good' });
  assert.equal(move.data.name, 'IMG_2 (1).jpg');
  assert.ok(has(good, 'IMG_2 (1).CR2'));
  const undo = await api('/api/undo', { s: r.id, f: 'IMG_2.jpg', name: 'IMG_2 (1).jpg', to: 'good' });
  assert.equal(undo.status, 200);
  assert.ok(has(proj, 'IMG_2.jpg') && has(proj, 'IMG_2.CR2'));
  assert.ok(has(good, 'IMG_2.jpg'), 'file lama di Bagus tidak tersentuh');
});

test('tanda dilewati tersimpan dan dihitung di daftar proyek (tanpa foto kembar)', async () => {
  let r = await start();
  const total = r.files.filter((x) => x.status !== 'good').length;
  assert.equal((await api('/api/mark', { s: r.id, f: 'IMG_3.jpg', status: 'kept' })).status, 200);
  r = await start();
  assert.equal(byName(r.files)['IMG_3.jpg'].status, 'kept');
  const card = await projectCard();
  assert.equal(card.count.skipped, 1);
  assert.equal(card.count.left, total - 1);

  await api('/api/mark', { s: r.id, f: 'IMG_3.jpg', status: null });
  r = await start();
  assert.equal(byName(r.files)['IMG_3.jpg'].status, null);
});

test('info foto: tanggal EXIF dan ukuran dibaca dari JPEG', async () => {
  const r = await start();
  const meta = (await api('/api/meta', { s: r.id, items: [{ f: 'IMG_1.jpg' }, { f: 'tidak-ada.jpg' }] })).data;
  assert.equal(meta[0].exact, true);
  assert.equal(meta[0].t, new Date(2024, 4, 1, 12, 30, 45).getTime());
  assert.equal(meta[0].w, 640);
  assert.equal(meta[0].h, 480);
  assert.equal(meta[1], null);
});

test('path di luar folder ditolak', async () => {
  const r = await start();
  assert.equal((await fetch(`${BASE}/img?s=${r.id}&f=${encodeURIComponent('../../x.jpg')}`)).status, 403);
  assert.equal((await fetch(`${BASE}/img?s=${r.id}&g=${encodeURIComponent('../x.jpg')}`)).status, 400);
  assert.equal((await api('/api/move', { s: r.id, f: '../x.jpg', to: 'good' })).status, 403);
  assert.equal((await api('/api/undo', { s: r.id, f: 'IMG_3.jpg', name: '../x', to: 'good' })).status, 400);
  assert.equal((await api('/api/move', { s: 'salah', f: 'IMG_3.jpg', to: 'good' })).status, 410);
});

test('server kedua di port yang sama tidak error, cukup membuka yang sudah ada', async () => {
  const code = await new Promise((resolve) => {
    spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: 'ignore' }).on('exit', resolve);
  });
  assert.equal(code, 0);
});

test('hapus proyek dari daftar ikut menghapus catatan pilihan, foto tetap ada', async () => {
  const r = await start();
  await api('/api/mark', { s: r.id, f: 'IMG_3.jpg', status: 'kept' });
  await api('/api/projects'); // memaksa catatan ditulis
  const dir = path.join(home, '.swipe-photo', 'decisions');
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal((await api('/api/forget', { src: proj })).status, 200);
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(await projectCard(), undefined);
  assert.ok(has(proj, 'IMG_3.jpg'));
});
