'use strict';

const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const archiver = require('archiver');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { createGithubStore } = require('./storage-github');

// ---------------------------------------------------------------------------
// تنظیمات
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-123';
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || ''; // خالی = آپلود آزاد
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '2048', 10);
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS || '12', 10);

const GB = 1024 * 1024 * 1024;

// سهمیه فضای روی همین سرور
const QUOTA_GB = parseFloat(process.env.STORAGE_QUOTA_GB || '5');
const QUOTA_BYTES = Math.round(QUOTA_GB * GB);

// کف فضای آزاد دیسک. مستقل از سهمیه عمل می‌کند تا اگر چیز دیگری روی
// سرور دیسک را پر کرد، آپلود باعث خفه شدن کل ماشین نشود.
const MIN_FREE_DISK_GB = parseFloat(process.env.MIN_FREE_DISK_GB || '2');
const MIN_FREE_DISK_BYTES = Math.round(MIN_FREE_DISK_GB * GB);

// گیت‌هاب — اگر توکن و ریپو نباشد، برنامه فقط محلی کار می‌کند
const gh = createGithubStore({
  token: process.env.GITHUB_TOKEN || '',
  repo: process.env.GITHUB_REPO || '',
  branch: process.env.GITHUB_BRANCH || 'main',
});
const GITHUB_QUOTA_GB = parseFloat(process.env.GITHUB_QUOTA_GB || '20');
const GITHUB_QUOTA_BYTES = Math.round(GITHUB_QUOTA_GB * GB);
const DB_SYNC_MS = parseInt(process.env.DB_SYNC_SECONDS || '20', 10) * 1000;
// مقصد پیش‌فرض آپلود؛ از پنل ادمین هم قابل تغییر است
const DEFAULT_TARGET = (process.env.STORAGE_BACKEND || (gh.enabled ? 'github' : 'local')).toLowerCase();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// دیتابیس ساده روی فایل (JSON) با نوشتن اتمیک
// ---------------------------------------------------------------------------
function normalizeDb(d) {
  d = d || {};
  if (!Array.isArray(d.files)) d.files = [];
  if (!Array.isArray(d.messages)) d.messages = [];
  if (!d.seq) d.seq = 0;
  if (!d.settings) d.settings = {};
  for (const f of d.files) if (!f.backend) f.backend = 'local';
  return d;
}

let localDbExisted = false;
let db = normalizeDb(null);
try {
  if (fs.existsSync(DB_FILE)) {
    db = normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    localDbExisted = true;
  }
} catch (e) {
  console.error('db.json خراب بود، از صفر شروع شد:', e.message);
}

let saveTimer = null;
function writeLocalDb() {
  const tmp = DB_FILE + '.tmp';
  return fsp.writeFile(tmp, JSON.stringify(db, null, 2)).then(() => fsp.rename(tmp, DB_FILE));
}

// opts.files=true یعنی فهرست فایل‌ها عوض شده (INDEX.md هم باید بازسازی شود)
function save(opts) {
  db.updatedAt = new Date().toISOString();
  if (opts && opts.files) indexDirty = true;
  scheduleRemote();
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await writeLocalDb();
    } catch (e) {
      console.error('ذخیره db ناموفق:', e.message);
    }
  }, 200);
}

function findFile(id) {
  return db.files.find((x) => x.id === id);
}

// ---------------------------------------------------------------------------
// همگام‌سازی db.json و INDEX.md با ریپو
// ---------------------------------------------------------------------------
let remoteTimer = null;
let remoteDirty = false;
let indexDirty = false;
let remotePushing = false;
let remoteState = { ok: null, at: null, error: null };

function scheduleRemote() {
  if (!gh.enabled) return;
  remoteDirty = true;
  if (!remoteTimer) remoteTimer = setTimeout(pushRemote, DB_SYNC_MS);
}

async function pushRemote() {
  remoteTimer = null;
  if (!gh.enabled || !remoteDirty) return;
  if (remotePushing) {
    remoteTimer = setTimeout(pushRemote, DB_SYNC_MS);
    return;
  }
  remotePushing = true;
  remoteDirty = false;
  const withIndex = indexDirty;
  indexDirty = false;
  try {
    await gh.putText('db.json', JSON.stringify(db, null, 2) + '\n', 'filebox: به‌روزرسانی db.json');
    if (withIndex) await gh.putText('INDEX.md', buildIndex(), 'filebox: به‌روزرسانی INDEX.md');
    remoteState = { ok: true, at: new Date().toISOString(), error: null };
  } catch (e) {
    remoteDirty = true;
    if (withIndex) indexDirty = true;
    remoteState = { ok: false, at: new Date().toISOString(), error: e.message };
    console.error('همگام‌سازی با گیت‌هاب ناموفق:', e.message);
  } finally {
    remotePushing = false;
  }
  if (remoteDirty && !remoteTimer) {
    remoteTimer = setTimeout(pushRemote, remoteState.ok === false ? 60000 : DB_SYNC_MS);
  }
}

// روی سرور تازه: اگر db محلی نیست یا نسخه‌ی ریپو تازه‌تر است، از ریپو بازیابی کن
async function restoreFromRemote() {
  if (!gh.enabled) return;
  let text;
  try {
    text = await gh.getText('db.json');
  } catch (e) {
    console.error('خواندن db.json از گیت‌هاب ناموفق:', e.message);
    return;
  }
  if (!text) {
    console.log('  ریپو هنوز db.json ندارد؛ نسخه‌ی فعلی آپلود می‌شود.');
    indexDirty = true;
    scheduleRemote();
    return;
  }
  let remote;
  try {
    remote = normalizeDb(JSON.parse(text));
  } catch (e) {
    console.error('db.json ریپو قابل خواندن نیست:', e.message);
    return;
  }
  const localTime = db.updatedAt || '';
  const remoteTime = remote.updatedAt || '';
  if (!localDbExisted || remoteTime > localTime) {
    db = remote;
    await writeLocalDb();
    console.log('  از ریپو بازیابی شد: ' + db.files.length + ' فایل، ' + db.messages.length + ' پیام');
  } else if (localTime > remoteTime) {
    indexDirty = true;
    scheduleRemote();
  }
}

// ---------------------------------------------------------------------------
// مقصد و سهمیه‌ها
// ---------------------------------------------------------------------------
function target() {
  const t = db.settings.target || DEFAULT_TARGET;
  return t === 'github' && gh.enabled ? 'github' : 'local';
}

function localUsed() {
  return db.files.reduce((s, f) => s + (f.backend === 'local' ? f.size || 0 : 0), 0);
}
function githubUsed() {
  return db.files.reduce((s, f) => s + (f.backend === 'github' ? f.size || 0 : 0), 0);
}

function quotaOf(used, bytes, gb) {
  return {
    bytes: bytes,
    gb: gb,
    used: used,
    remaining: Math.max(0, bytes - used),
    percent: bytes > 0 ? Math.min(100, Math.round((used / bytes) * 1000) / 10) : 0,
    full: used >= bytes,
  };
}
function quotaInfo() {
  return quotaOf(localUsed(), QUOTA_BYTES, QUOTA_GB);
}
function githubQuotaInfo() {
  return quotaOf(githubUsed(), GITHUB_QUOTA_BYTES, GITHUB_QUOTA_GB);
}

async function diskInfo() {
  try {
    const st = await fsp.statfs(DATA_DIR);
    return { free: st.bfree * st.bsize, total: st.blocks * st.bsize };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// دسته‌بندی و نام‌گذاری مرتب فایل‌ها
// ---------------------------------------------------------------------------
const CATEGORIES = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'flv'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
  code: ['js', 'ts', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'sh', 'json', 'html', 'css', 'yml', 'yaml', 'sql'],
};
const CAT_LABELS = {
  image: '🖼️ تصویر', video: '🎬 ویدیو', audio: '🎵 صدا', document: '📄 سند',
  archive: '🗜️ آرشیو', code: '💻 کد', other: '📎 سایر',
};

function categoryOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  for (const cat of Object.keys(CATEGORIES)) {
    if (CATEGORIES[cat].indexOf(ext) !== -1) return cat;
  }
  return 'other';
}

function safeName(name) {
  const cleaned = path
    .basename(name)
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return cleaned || 'file';
}

// ساختار مرتب: uploads/<دسته>/<سال-ماه>/<تاریخ>_<id>__<نام اصلی>
function relPathFor(originalName, id, date) {
  const cat = categoryOf(originalName);
  const ym = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return path.join(cat, ym, ym + '-' + day + '_' + id + '__' + safeName(originalName));
}

function localPath(rec) {
  const abs = path.resolve(UPLOAD_DIR, rec.rel);
  if (!abs.startsWith(path.resolve(UPLOAD_DIR))) return null;
  return abs;
}

function fmtGB(b) {
  return (b / GB).toFixed(2) + ' GB';
}
function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

// فهرست خوانا برای ریپو — مرتب بر اساس دسته و ماه
function buildIndex() {
  const md = (s) => String(s).replace(/([|\[\]\\*_`<>])/g, '\\$1');
  const total = db.files.reduce((s, f) => s + (f.size || 0), 0);
  const lines = [
    '# 📦 FileBox — فهرست فایل‌ها',
    '',
    'این فایل خودکار ساخته می‌شود؛ دستی ویرایشش نکنید.',
    '',
    '- به‌روزرسانی: ' + new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    '- ' + db.files.length + ' فایل، مجموعاً ' + fmtSize(total),
    '- روی گیت‌هاب: ' + fmtSize(githubUsed()) + ' — روی سرور: ' + fmtSize(localUsed()),
    '',
  ];
  const byCat = {};
  for (const f of db.files) (byCat[f.category] = byCat[f.category] || []).push(f);
  for (const cat of Object.keys(CAT_LABELS)) {
    const list = byCat[cat];
    if (!list) continue;
    const size = list.reduce((s, f) => s + (f.size || 0), 0);
    lines.push('## ' + CAT_LABELS[cat] + ' — ' + list.length + ' فایل، ' + fmtSize(size), '');
    const byMonth = {};
    for (const f of list) (byMonth[f.createdAt.slice(0, 7)] = byMonth[f.createdAt.slice(0, 7)] || []).push(f);
    for (const month of Object.keys(byMonth).sort().reverse()) {
      lines.push('### ' + month, '', '| نام | حجم | تاریخ | آپلودکننده | محل |', '|---|---|---|---|---|');
      for (const f of byMonth[month].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        const name = f.backend === 'github' && f.gh && f.gh.assetUrl
          ? '[' + md(f.name) + '](' + f.gh.assetUrl + ')'
          : md(f.name);
        const where = f.backend === 'github' ? '☁️ گیت‌هاب' : '🖥️ سرور';
        lines.push('| ' + name + ' | ' + fmtSize(f.size) + ' | ' + f.createdAt.slice(0, 10) +
          ' | ' + md(f.uploader) + ' | ' + where + ' |');
      }
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// آپلود
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const id = crypto.randomBytes(8).toString('hex');
    const rel = relPathFor(file.originalname, id, new Date());
    file._id = id;
    file._rel = rel;
    const dir = path.join(UPLOAD_DIR, path.dirname(rel));
    fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
  },
  filename(req, file, cb) {
    cb(null, path.basename(file._rel));
  },
});

// multer به‌طور پیش‌فرض نام فایل را latin1 می‌خواند و نام‌های فارسی خراب می‌شوند؛
// مرورگرها نام فایل را UTF-8 می‌فرستند.
const upload = multer({
  storage,
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
});

function registerFile(file, uploader, source) {
  const rec = {
    id: file._id,
    name: file.originalname,
    rel: file._rel.split(path.sep).join('/'),
    size: file.size,
    mime: file.mimetype,
    category: categoryOf(file.originalname),
    uploader: String(uploader || 'ناشناس').slice(0, 40),
    source: source, // 'upload' | 'chat'
    createdAt: new Date().toISOString(),
    backend: 'local',
  };
  db.files.push(rec);
  return rec;
}

function publicFile(f) {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    category: f.category,
    uploader: f.uploader,
    createdAt: f.createdAt,
    source: f.source,
    backend: f.backend,
    sync: f.sync || null,
    syncDir: f.syncDir || null,
    syncError: f.syncError || null,
  };
}

// فایل همیشه اول روی همین سرور نوشته می‌شود (حتی وقتی مقصد گیت‌هاب است)،
// پس کف دیسک و سهمیه‌ی سرور همیشه بررسی می‌شوند.
async function checkQuota(req, res, next) {
  const incoming = parseInt(req.headers['content-length'] || '0', 10);

  const disk = await diskInfo();
  if (disk && disk.free - incoming < MIN_FREE_DISK_BYTES) {
    return res.status(507).json({
      error:
        'فضای دیسک سرور کم است (' + fmtGB(disk.free) + ' آزاد، کف مجاز ' +
        MIN_FREE_DISK_GB + ' GB). آپلود موقتاً غیرفعال است.',
      quota: quotaInfo(),
    });
  }

  const q = quotaInfo();
  if (q.full) {
    return res.status(507).json({
      error: 'فضای سرور پر است (' + fmtGB(q.used) + ' از ' + QUOTA_GB + ' GB). اول چند فایل پاک یا به گیت‌هاب منتقل کنید.',
      quota: q,
    });
  }
  if (incoming && q.used + incoming > QUOTA_BYTES) {
    return res.status(507).json({
      error: 'این آپلود از سهمیه سرور رد می‌شود. باقی‌مانده: ' + fmtGB(q.remaining) + ' — حجم ارسالی: ' + fmtGB(incoming),
      quota: q,
    });
  }
  next();
}

async function rollbackIfOverQuota(added) {
  if (localUsed() <= QUOTA_BYTES) return null;
  for (const rec of added) {
    const i = db.files.findIndex((x) => x.id === rec.id);
    if (i !== -1) db.files.splice(i, 1);
    unlinkQuiet(localPath(rec));
  }
  save({ files: true });
  return 'آپلود لغو شد چون از سهمیه ' + QUOTA_GB + ' گیگابایتی سرور رد می‌شد.';
}

// بعد از ثبت، اگر مقصد گیت‌هاب است در صف انتقال می‌رود.
// پاسخ به کاربر منتظر گیت‌هاب نمی‌ماند؛ پشت کلادفلر تایم‌اوت ۱۰۰ ثانیه‌ای هست.
function routeNewFiles(recs) {
  if (target() !== 'github') return;
  for (const r of recs) enqueue(r.id, 'toGithub');
}

// ---------------------------------------------------------------------------
// صف انتقال بین سرور و گیت‌هاب (یکی‌یکی)
// ---------------------------------------------------------------------------
const jobs = [];
let working = false;

function enqueue(id, dir) {
  const rec = findFile(id);
  if (!rec) return false;
  if (dir === 'toGithub' && rec.backend !== 'local') return false;
  if (dir === 'toLocal' && rec.backend !== 'github') return false;
  if (jobs.some((j) => j.id === id)) return false;
  rec.sync = 'pending';
  rec.syncDir = dir;
  delete rec.syncError;
  jobs.push({ id: id, dir: dir });
  save();
  setImmediate(pump);
  return true;
}

async function pump() {
  if (working) return;
  working = true;
  try {
    while (jobs.length) {
      const job = jobs.shift();
      try {
        if (job.dir === 'toGithub') await pushToGithub(job.id);
        else await pullToLocal(job.id);
      } catch (e) {
        const rec = findFile(job.id);
        if (rec) {
          rec.sync = 'failed';
          rec.syncError = String(e.message || e).slice(0, 300);
          save();
        }
        console.error('انتقال ' + job.dir + ' برای ' + job.id + ' ناموفق:', e.message);
      }
    }
  } finally {
    working = false;
  }
}

function tagFor(rec) {
  // هر release حداکثر ۱۰۰۰ asset دارد؛ ماه‌های پرکار به چند release شکسته می‌شوند
  const base = 'files-' + rec.createdAt.slice(0, 7);
  const n = db.files.filter((f) => f.backend === 'github' && f.gh && f.gh.tag && f.gh.tag.indexOf(base) === 0).length;
  const part = Math.floor(n / 990) + 1;
  return part > 1 ? base + '-' + part : base;
}

async function pushToGithub(id) {
  const rec = findFile(id);
  if (!rec || rec.backend !== 'local') return;
  const abs = localPath(rec);
  if (!abs || !fs.existsSync(abs)) throw new Error('فایل روی سرور پیدا نشد');
  if (rec.size > gh.maxAssetBytes) throw new Error('بزرگ‌تر از سقف ۲ گیگابایتی گیت‌هاب — روی سرور ماند');
  if (githubUsed() + rec.size > GITHUB_QUOTA_BYTES) {
    throw new Error('سهمیه ' + GITHUB_QUOTA_GB + ' گیگابایتی گیت‌هاب پر است — روی سرور ماند');
  }

  const info = await gh.uploadFile(rec, abs, tagFor(rec));

  // اگر وسط آپلود کاربر فایل را پاک کرده باشد، asset یتیم را هم پاک کن
  const still = findFile(id);
  if (!still) {
    await gh.deleteAsset(info.assetId).catch(() => {});
    return;
  }
  still.backend = 'github';
  still.gh = info;
  delete still.sync;
  delete still.syncDir;
  delete still.syncError;
  save({ files: true });
  unlinkQuiet(abs);
}

async function pullToLocal(id) {
  const rec = findFile(id);
  if (!rec || rec.backend !== 'github') return;
  const disk = await diskInfo();
  if (disk && disk.free - rec.size < MIN_FREE_DISK_BYTES) throw new Error('فضای دیسک سرور کافی نیست');
  if (localUsed() + rec.size > QUOTA_BYTES) throw new Error('سهمیه سرور جا ندارد');

  const abs = localPath(rec);
  if (!abs) throw new Error('مسیر نامعتبر');
  const part = abs + '.part';
  await gh.downloadToFile(rec.gh.assetId, part);
  await fsp.rename(part, abs);

  const still = findFile(id);
  if (!still) {
    unlinkQuiet(abs);
    return;
  }
  const assetId = still.gh.assetId;
  still.backend = 'local';
  delete still.gh;
  delete still.sync;
  delete still.syncDir;
  delete still.syncError;
  save({ files: true });
  await gh.deleteAsset(assetId).catch((e) => console.error('asset ' + assetId + ' پاک نشد:', e.message));
}

// روی ویندوز فایلی که هنوز باز است پاک نمی‌شود؛ بعداً دوباره تلاش می‌کنیم
const pendingUnlinks = new Map(); // path -> tries
function unlinkQuiet(abs) {
  if (!abs) return;
  fs.unlink(abs, (err) => {
    if (err && err.code !== 'ENOENT') pendingUnlinks.set(abs, (pendingUnlinks.get(abs) || 0) + 1);
  });
}
setInterval(() => {
  for (const [abs, tries] of pendingUnlinks) {
    pendingUnlinks.delete(abs);
    if (tries < 10) unlinkQuiet(abs);
  }
}, 60000).unref();

// ---------------------------------------------------------------------------
// احراز هویت پنل ادمین
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> expiresAt
const attempts = new Map(); // ip -> {count, until}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 60000).unref();

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_HOURS * 3600000);
  return token;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isLoggedIn(req) {
  const token = req.cookies && req.cookies.fb_token;
  return Boolean(token && sessions.get(token) > Date.now());
}

function requireAuth(req, res, next) {
  if (!isLoggedIn(req)) return res.status(401).json({ error: 'نیاز به ورود با رمز' });
  next();
}

function checkUploadPassword(req, res, next) {
  if (!UPLOAD_PASSWORD) return next();
  const given = req.headers['x-upload-password'] || '';
  if (safeEqual(given, UPLOAD_PASSWORD)) return next();
  if (isLoggedIn(req)) return next(); // ادمین لاگین‌کرده هم اجازه دارد
  return res.status(401).json({ error: 'رمز آپلود اشتباه است' });
}

// ---------------------------------------------------------------------------
// اپ
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', true); // پشت nginx / تانل کلادفلر
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api', (req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
// no-cache: مرورگر هر بار با ETag بررسی می‌کند، تا بعد از استقرار app.js قدیمی
// با API جدید اجرا نشود
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

function storageSummary() {
  return { github: gh.enabled, target: target() };
}

app.get('/api/config', (req, res) => {
  res.json({
    uploadProtected: Boolean(UPLOAD_PASSWORD),
    maxFileMB: MAX_FILE_MB,
    loggedIn: isLoggedIn(req),
    quota: quotaInfo(),
    githubQuota: gh.enabled ? githubQuotaInfo() : null,
    storage: storageSummary(),
  });
});

// ---- آپلود ---------------------------------------------------------------
app.post('/api/upload', checkUploadPassword, checkQuota, upload.array('files', 50), async (req, res) => {
  const uploader = req.body.uploader || 'ناشناس';
  const added = (req.files || []).map((f) => registerFile(f, uploader, 'upload'));
  const err = await rollbackIfOverQuota(added);
  if (err) return res.status(507).json({ error: err, quota: quotaInfo() });
  save({ files: true });
  routeNewFiles(added);
  res.json({
    ok: true,
    files: added.map(publicFile),
    target: target(),
    quota: quotaInfo(),
    githubQuota: gh.enabled ? githubQuotaInfo() : null,
  });
});

// ---- چت ------------------------------------------------------------------
app.get('/api/messages', (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const msgs = db.messages.filter((m) => m.seq > since).slice(-300);
  res.json({ messages: msgs, last: db.seq });
});

app.post('/api/messages', checkUploadPassword, checkQuota, upload.single('file'), async (req, res) => {
  const name = String(req.body.name || 'ناشناس').slice(0, 40);
  const text = String(req.body.text || '').slice(0, 4000);
  const fileRec = req.file ? registerFile(req.file, name, 'chat') : null;

  if (fileRec) {
    const err = await rollbackIfOverQuota([fileRec]);
    if (err) return res.status(507).json({ error: err, quota: quotaInfo() });
  }
  if (!text.trim() && !fileRec) return res.status(400).json({ error: 'پیام خالی است' });

  const msg = {
    seq: ++db.seq,
    name: name,
    text: text.trim(),
    file: fileRec ? { id: fileRec.id, name: fileRec.name, size: fileRec.size, category: fileRec.category } : null,
    at: new Date().toISOString(),
  };
  db.messages.push(msg);
  if (db.messages.length > 2000) db.messages.splice(0, db.messages.length - 2000);
  save({ files: Boolean(fileRec) });
  if (fileRec) routeNewFiles([fileRec]);
  res.json({ ok: true, message: msg });
});

// ---- ورود / خروج ---------------------------------------------------------
app.post('/api/login', (req, res) => {
  const ip = req.ip || 'x';
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) {
    return res.status(429).json({ error: 'تلاش زیاد. یک دقیقه صبر کنید.' });
  }
  if (!safeEqual((req.body && req.body.password) || '', ADMIN_PASSWORD)) {
    const cur = a || { count: 0, until: 0 };
    cur.count++;
    if (cur.count >= 5) {
      cur.until = Date.now() + 60000;
      cur.count = 0;
    }
    attempts.set(ip, cur);
    return res.status(401).json({ error: 'رمز اشتباه است' });
  }
  attempts.delete(ip);
  const token = issueToken();
  res.cookie('fb_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_HOURS * 3600000,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const t = req.cookies && req.cookies.fb_token;
  if (t) sessions.delete(t);
  res.clearCookie('fb_token');
  res.json({ ok: true });
});

// ---- تنظیمات ذخیره‌سازی --------------------------------------------------
app.post('/api/settings', requireAuth, (req, res) => {
  const t = req.body && req.body.target;
  if (t !== 'github' && t !== 'local') return res.status(400).json({ error: 'مقصد نامعتبر' });
  if (t === 'github' && !gh.enabled) return res.status(400).json({ error: 'گیت‌هاب روی این سرور تنظیم نشده' });
  db.settings.target = t;
  save();
  res.json({ ok: true, storage: storageSummary() });
});

app.post('/api/github/check', requireAuth, async (req, res) => {
  res.json(await gh.check());
});

// ---- لیست فایل‌ها (نیاز به رمز) -----------------------------------------
app.get('/api/files', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const cat = req.query.category || '';
  const where = req.query.where || ''; // '' | github | local
  const sort = req.query.sort || 'new'; // new | old | big | small | name
  let list = db.files.slice();

  if (q) list = list.filter((f) => f.name.toLowerCase().includes(q) || f.uploader.toLowerCase().includes(q));
  if (cat) list = list.filter((f) => f.category === cat);
  if (where) list = list.filter((f) => f.backend === where);

  const sorters = {
    new: (a, b) => b.createdAt.localeCompare(a.createdAt),
    old: (a, b) => a.createdAt.localeCompare(b.createdAt),
    big: (a, b) => (b.size || 0) - (a.size || 0),
    small: (a, b) => (a.size || 0) - (b.size || 0),
    name: (a, b) => a.name.localeCompare(b.name, 'fa'),
  };
  list.sort(sorters[sort] || sorters.new);

  const counts = {};
  const sizes = {};
  for (const f of db.files) {
    counts[f.category] = (counts[f.category] || 0) + 1;
    sizes[f.category] = (sizes[f.category] || 0) + (f.size || 0);
  }

  const status = gh.status();
  res.json({
    files: list.map((f) => {
      const p = publicFile(f);
      // فایل «روی سرور» که روی این ماشین نیست — مثلاً بعد از بالا آمدن روی سرور تازه
      if (f.backend === 'local') {
        const abs = localPath(f);
        p.missing = !abs || !fs.existsSync(abs);
      }
      return p;
    }),
    counts: counts,
    sizes: sizes,
    total: db.files.length,
    totalSize: db.files.reduce((s, f) => s + (f.size || 0), 0),
    quota: quotaInfo(),
    githubQuota: gh.enabled ? githubQuotaInfo() : null,
    github: gh.enabled
      ? {
          repo: gh.repo,
          url: status.url || 'https://github.com/' + gh.repo,
          ok: status.ok,
          error: status.error || null,
          warning: status.warning || null,
          sync: remoteState,
          queue: jobs.length + (working ? 1 : 0),
        }
      : null,
    storage: storageSummary(),
    disk: await diskInfo(),
    minFreeDiskGB: MIN_FREE_DISK_GB,
  });
});

// ---- دانلود / پیش‌نمایش --------------------------------------------------
async function openRead(rec) {
  if (rec.backend === 'github') {
    const d = await gh.openDownload(rec.gh.assetId);
    return { stream: d.stream, size: d.size || rec.size };
  }
  const abs = localPath(rec);
  if (!abs || !fs.existsSync(abs)) {
    const e = new Error('این فایل روی این سرور نیست');
    e.status = 404;
    throw e;
  }
  return { stream: fs.createReadStream(abs), size: (await fsp.stat(abs)).size };
}

function pipeTo(res, r) {
  if (r.size) res.set('Content-Length', String(r.size));
  r.stream.on('error', (e) => {
    console.error('خطای استریم:', e.message);
    res.destroy();
  });
  res.on('close', () => r.stream.destroy());
  r.stream.pipe(res);
}

app.get('/api/download/:id', requireAuth, async (req, res) => {
  const rec = findFile(req.params.id);
  if (!rec) return res.status(404).send('یافت نشد');
  try {
    const r = await openRead(rec);
    res.attachment(rec.name);
    pipeTo(res, r);
  } catch (e) {
    res.status(e.status === 404 ? 404 : 502).send(e.message);
  }
});

// پیش‌نمایش فقط برای نوع‌های امن. بقیه (html، svg و ...) اجباراً دانلود می‌شوند؛
// چون آپلود بدون رمز است، نمایش inline آن‌ها روی همین دامنه یعنی XSS در پنل ادمین.
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf|text\/plain)$/i;

app.get('/api/view/:id', requireAuth, async (req, res) => {
  const rec = findFile(req.params.id);
  if (!rec) return res.status(404).send('یافت نشد');
  try {
    const r = await openRead(rec);
    const mime = String(rec.mime || '');
    if (INLINE_SAFE.test(mime)) {
      res.type(mime);
      res.set('Content-Disposition', 'inline');
      if (mime !== 'application/pdf') res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    } else {
      res.attachment(rec.name);
    }
    pipeTo(res, r);
  } catch (e) {
    res.status(e.status === 404 ? 404 : 502).send(e.message);
  }
});

// دانلود گروهی zip — فایل‌های گیت‌هاب یکی‌یکی استریم می‌شوند
app.get('/api/zip', requireAuth, async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  const cat = req.query.category || '';
  let list = db.files;
  if (ids.length) list = list.filter((f) => ids.indexOf(f.id) !== -1);
  else if (cat) list = list.filter((f) => f.category === cat);
  if (!list.length) return res.status(404).send('فایلی نیست');

  const stamp = new Date().toISOString().slice(0, 10);
  res.attachment('filebox-' + (cat || 'selected') + '-' + stamp + '.zip');
  const zip = archiver('zip', { zlib: { level: 6 } });
  let appended = 0;
  let processed = 0;
  let aborted = false;
  zip.on('entry', () => processed++);
  zip.on('error', (err) => {
    console.error(err);
    res.destroy();
  });
  res.on('close', () => {
    aborted = true;
  });
  zip.pipe(res);

  const waitDrain = () =>
    new Promise((resolve) => {
      const tick = () => (processed >= appended || aborted ? resolve() : zip.once('entry', tick));
      tick();
    });

  const used = new Set();
  for (const f of list) {
    if (aborted) break;
    let name = f.category + '/' + f.name;
    if (used.has(name)) {
      const ext = path.extname(f.name);
      name = f.category + '/' + path.basename(f.name, ext) + '-' + f.id.slice(0, 6) + ext;
    }
    used.add(name);
    try {
      await waitDrain(); // حداکثر یک دانلود هم‌زمان از گیت‌هاب
      const r = await openRead(f);
      zip.append(r.stream, { name: name });
      appended++;
    } catch (e) {
      zip.append('دریافت این فایل ناموفق بود: ' + e.message + '\n', { name: name + '.ERROR.txt' });
      appended++;
    }
  }
  if (!aborted) zip.finalize();
});

// ---- حذف و انتقال --------------------------------------------------------
async function removeById(id) {
  const rec = findFile(id);
  if (!rec) return { ok: false, freed: 0, error: 'یافت نشد' };
  if (rec.backend === 'github') {
    try {
      await gh.deleteAsset(rec.gh.assetId);
    } catch (e) {
      return { ok: false, freed: 0, error: e.message };
    }
  }
  const i = db.files.indexOf(rec);
  if (i !== -1) db.files.splice(i, 1);
  const qi = jobs.findIndex((j) => j.id === id);
  if (qi !== -1) jobs.splice(qi, 1);
  if (rec.backend === 'local') unlinkQuiet(localPath(rec));
  return { ok: true, freed: rec.size || 0 };
}

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const r = await removeById(req.params.id);
  if (!r.ok) return res.status(r.error === 'یافت نشد' ? 404 : 502).json({ error: r.error });
  save({ files: true });
  res.json({ ok: true, freed: r.freed, quota: quotaInfo() });
});

// حذف گروهی: با فهرست شناسه‌ها یا کل یک دسته
app.post('/api/files/bulk-delete', requireAuth, async (req, res) => {
  const body = req.body || {};
  let ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length && body.category) {
    ids = db.files.filter((f) => f.category === body.category).map((f) => f.id);
  }
  if (!ids.length) return res.status(400).json({ error: 'چیزی برای حذف انتخاب نشده' });

  let freed = 0;
  let removed = 0;
  const errors = [];
  for (const id of ids) {
    const r = await removeById(id);
    if (r.ok) {
      removed++;
      freed += r.freed;
    } else errors.push(r.error);
  }
  save({ files: true });
  res.json({ ok: true, removed: removed, failed: errors.length, errors: errors.slice(0, 5), freed: freed, quota: quotaInfo() });
});

app.post('/api/files/move', requireAuth, (req, res) => {
  const body = req.body || {};
  const ids = Array.isArray(body.ids) ? body.ids : [];
  const to = body.to;
  if (to !== 'github' && to !== 'local') return res.status(400).json({ error: 'مقصد نامعتبر' });
  if (!gh.enabled) return res.status(400).json({ error: 'گیت‌هاب روی این سرور تنظیم نشده' });
  let queued = 0;
  for (const id of ids) if (enqueue(id, to === 'github' ? 'toGithub' : 'toLocal')) queued++;
  res.json({ ok: true, queued: queued, skipped: ids.length - queued });
});

app.get('/healthz', (req, res) => {
  const q = quotaInfo();
  res.json({
    ok: true,
    files: db.files.length,
    usedBytes: q.used,
    quotaBytes: q.bytes,
    percent: q.percent,
    target: target(),
    github: gh.enabled ? { ok: gh.status().ok, sync: remoteState.ok, queue: jobs.length } : null,
  });
});

// خطاهای multer (مثل حجم زیاد)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: 'خطای آپلود: ' + err.code + ' (سقف ' + MAX_FILE_MB + 'MB برای هر فایل)' });
  }
  console.error(err);
  res.status(500).json({ error: 'خطای سرور' });
});

// ---------------------------------------------------------------------------
// شروع و خاتمه
// ---------------------------------------------------------------------------
async function main() {
  if (gh.enabled) {
    const st = await gh.check();
    if (st.ok) await restoreFromRemote();
    else console.error('  گیت‌هاب در دسترس نیست: ' + st.error + ' — فایل‌ها فعلاً روی سرور می‌مانند.');
  }

  // انتقال‌هایی که با ری‌استارت نیمه‌کاره ماندند
  for (const f of db.files) {
    if (f.sync === 'pending' && f.syncDir) {
      delete f.sync;
      enqueue(f.id, f.syncDir);
    }
  }

  // وضعیت اتصال گیت‌هاب را هر ۵ دقیقه تازه کن
  if (gh.enabled) setInterval(() => gh.check().catch(() => {}), 5 * 60000).unref();

  app.listen(PORT, HOST, () => {
    const q = quotaInfo();
    console.log('──────────────────────────────────────────');
    console.log('  FileBox بالا آمد ✅');
    console.log('  آدرس محلی  : http://localhost:' + PORT);
    console.log('  مسیر داده  : ' + DATA_DIR);
    console.log('  سهمیه سرور : ' + fmtGB(q.used) + ' از ' + QUOTA_GB + ' GB (' + q.percent + '%)');
    console.log('  کف دیسک    : ' + MIN_FREE_DISK_GB + ' GB');
    console.log('  گیت‌هاب     : ' + (gh.enabled ? gh.repo + ' (' + (gh.status().ok ? 'متصل' : 'قطع') + ')' : 'غیرفعال'));
    console.log('  مقصد آپلود : ' + (target() === 'github' ? 'گیت‌هاب' : 'همین سرور'));
    console.log('  رمز پنل    : ' + (ADMIN_PASSWORD === 'change-me-123' ? '⚠️  پیش‌فرض — حتماً عوضش کن!' : 'از ENV خوانده شد'));
    console.log('──────────────────────────────────────────');
  });
}

// قبل از خروج، تغییرات db را به ریپو برسان
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('دریافت ' + sig + '؛ ذخیره و خروج...');
  try {
    await writeLocalDb();
    if (gh.enabled && remoteDirty) {
      if (remoteTimer) clearTimeout(remoteTimer);
      await Promise.race([pushRemote(), new Promise((r) => setTimeout(r, 10000))]);
    }
  } catch (e) {
    console.error('خطا هنگام خروج:', e.message);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  console.error('راه‌اندازی ناموفق:', e);
  process.exit(1);
});
