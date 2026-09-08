'use strict';

const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const archiver = require('archiver');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

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

// سهمیه کل فضا — پیش‌فرض ۵ گیگابایت
const QUOTA_GB = parseFloat(process.env.STORAGE_QUOTA_GB || '5');
const QUOTA_BYTES = Math.round(QUOTA_GB * 1024 * 1024 * 1024);

// کف فضای آزاد دیسک. مستقل از سهمیه عمل می‌کند تا اگر چیز دیگری روی
// سرور دیسک را پر کرد، آپلود باعث خفه شدن کل ماشین نشود.
const MIN_FREE_DISK_GB = parseFloat(process.env.MIN_FREE_DISK_GB || '2');
const MIN_FREE_DISK_BYTES = Math.round(MIN_FREE_DISK_GB * 1024 * 1024 * 1024);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// دیتابیس ساده روی فایل (JSON) با نوشتن اتمیک
// ---------------------------------------------------------------------------
let db = { files: [], messages: [], seq: 0 };
try {
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
} catch (e) {
  console.error('db.json خراب بود، از صفر شروع شد:', e.message);
}
if (!db.files) db.files = [];
if (!db.messages) db.messages = [];
if (!db.seq) db.seq = 0;

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = DB_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
      await fsp.rename(tmp, DB_FILE);
    } catch (e) {
      console.error('ذخیره db ناموفق:', e.message);
    }
  }, 200);
}

// ---------------------------------------------------------------------------
// محاسبه فضای مصرف‌شده
// ---------------------------------------------------------------------------
function usedBytes() {
  return db.files.reduce((s, f) => s + (f.size || 0), 0);
}

function quotaInfo() {
  const used = usedBytes();
  return {
    bytes: QUOTA_BYTES,
    gb: QUOTA_GB,
    used: used,
    remaining: Math.max(0, QUOTA_BYTES - used),
    percent: QUOTA_BYTES > 0 ? Math.min(100, Math.round((used / QUOTA_BYTES) * 1000) / 10) : 0,
    full: used >= QUOTA_BYTES,
  };
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

const upload = multer({ storage, limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });

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
  };
}

function fmtGB(b) {
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// جلوی آپلودی که از سهمیه رد می‌شود را قبل از نوشتن روی دیسک می‌گیرد
async function checkQuota(req, res, next) {
  const incomingLen = parseInt(req.headers['content-length'] || '0', 10);

  // محافظ دیسک — قبل از سهمیه بررسی می‌شود
  const disk = await diskInfo();
  if (disk && disk.free - incomingLen < MIN_FREE_DISK_BYTES) {
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
      error: 'فضای ذخیره‌سازی پر است (' + fmtGB(q.used) + ' از ' + QUOTA_GB + ' GB). اول چند فایل پاک کنید.',
      quota: q,
    });
  }
  const incoming = incomingLen;
  if (incoming && q.used + incoming > QUOTA_BYTES) {
    return res.status(507).json({
      error:
        'این آپلود از سهمیه رد می‌شود. فضای باقی‌مانده: ' + fmtGB(q.remaining) +
        ' — حجم ارسالی: ' + fmtGB(incoming),
      quota: q,
    });
  }
  next();
}

// اگر با وجود بررسی اولیه از سهمیه رد شد، همان فایل‌های تازه را برمی‌گرداند
async function rollbackIfOverQuota(added) {
  if (usedBytes() <= QUOTA_BYTES) return null;
  for (const rec of added) {
    const i = db.files.findIndex((x) => x.id === rec.id);
    if (i !== -1) db.files.splice(i, 1);
    try {
      await fsp.unlink(path.join(UPLOAD_DIR, rec.rel));
    } catch (e) {
      /* از قبل نبوده */
    }
  }
  save();
  return 'آپلود لغو شد چون از سهمیه ' + QUOTA_GB + ' گیگابایت رد می‌شد.';
}

// ---------------------------------------------------------------------------
// احراز هویت پنل دانلود
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
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    uploadProtected: Boolean(UPLOAD_PASSWORD),
    maxFileMB: MAX_FILE_MB,
    loggedIn: isLoggedIn(req),
    quota: quotaInfo(),
  });
});

// ---- آپلود ---------------------------------------------------------------
app.post('/api/upload', checkUploadPassword, checkQuota, upload.array('files', 50), async (req, res) => {
  const uploader = req.body.uploader || 'ناشناس';
  const added = (req.files || []).map((f) => registerFile(f, uploader, 'upload'));
  const err = await rollbackIfOverQuota(added);
  if (err) return res.status(507).json({ error: err, quota: quotaInfo() });
  save();
  res.json({ ok: true, files: added.map(publicFile), quota: quotaInfo() });
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
    file: fileRec ? publicFile(fileRec) : null,
    at: new Date().toISOString(),
  };
  db.messages.push(msg);
  if (db.messages.length > 2000) db.messages.splice(0, db.messages.length - 2000);
  save();
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

// ---- لیست و دانلود (نیاز به رمز) ----------------------------------------
app.get('/api/files', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const cat = req.query.category || '';
  const sort = req.query.sort || 'new'; // new | old | big | small | name
  let list = db.files.slice();

  if (q) list = list.filter((f) => f.name.toLowerCase().includes(q) || f.uploader.toLowerCase().includes(q));
  if (cat) list = list.filter((f) => f.category === cat);

  const sorters = {
    new: (a, b) => b.createdAt.localeCompare(a.createdAt),
    old: (a, b) => a.createdAt.localeCompare(b.createdAt),
    big: (a, b) => (b.size || 0) - (a.size || 0),
    small: (a, b) => (a.size || 0) - (b.size || 0),
    name: (a, b) => a.name.localeCompare(b.name, 'fa'),
  };
  list.sort(sorters[sort] || sorters.new);

  // آمار هر دسته: تعداد و حجم
  const counts = {};
  const sizes = {};
  for (const f of db.files) {
    counts[f.category] = (counts[f.category] || 0) + 1;
    sizes[f.category] = (sizes[f.category] || 0) + (f.size || 0);
  }

  res.json({
    files: list.map((f) => Object.assign(publicFile(f), { rel: f.rel })),
    counts: counts,
    sizes: sizes,
    total: db.files.length,
    totalSize: usedBytes(),
    filteredSize: list.reduce((s, f) => s + (f.size || 0), 0),
    quota: quotaInfo(),
    disk: await diskInfo(),
    minFreeDiskGB: MIN_FREE_DISK_GB,
  });
});

function resolveFile(id) {
  const f = db.files.find((x) => x.id === id);
  if (!f) return null;
  const abs = path.resolve(UPLOAD_DIR, f.rel);
  if (!abs.startsWith(path.resolve(UPLOAD_DIR))) return null;
  return { f: f, abs: abs };
}

app.get('/api/download/:id', requireAuth, (req, res) => {
  const r = resolveFile(req.params.id);
  if (!r) return res.status(404).send('یافت نشد');
  res.download(r.abs, r.f.name);
});

// پیش‌نمایش داخل مرورگر (بدون دانلود اجباری)
app.get('/api/view/:id', requireAuth, (req, res) => {
  const r = resolveFile(req.params.id);
  if (!r) return res.status(404).send('یافت نشد');
  res.type(r.f.mime || 'application/octet-stream').sendFile(r.abs);
});

// دانلود گروهی به صورت zip با ساختار پوشه‌بندی‌شده
app.get('/api/zip', requireAuth, (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  const cat = req.query.category || '';
  let list = db.files;
  if (ids.length) list = list.filter((f) => ids.indexOf(f.id) !== -1);
  else if (cat) list = list.filter((f) => f.category === cat);
  if (!list.length) return res.status(404).send('فایلی نیست');

  const stamp = new Date().toISOString().slice(0, 10);
  res.attachment('filebox-' + (cat || 'all') + '-' + stamp + '.zip');
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', (err) => {
    console.error(err);
    res.destroy();
  });
  zip.pipe(res);
  for (const f of list) {
    const abs = path.join(UPLOAD_DIR, f.rel);
    if (fs.existsSync(abs)) zip.file(abs, { name: f.category + '/' + f.name });
  }
  zip.finalize();
});

async function removeById(id) {
  const i = db.files.findIndex((x) => x.id === id);
  if (i === -1) return 0;
  const f = db.files.splice(i, 1)[0];
  try {
    await fsp.unlink(path.join(UPLOAD_DIR, f.rel));
  } catch (e) {
    /* فایل از قبل نبوده */
  }
  return f.size || 0;
}

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  const before = db.files.length;
  const freed = await removeById(req.params.id);
  if (db.files.length === before) return res.status(404).json({ error: 'یافت نشد' });
  save();
  res.json({ ok: true, freed: freed, quota: quotaInfo() });
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
  for (const id of ids) {
    const before = db.files.length;
    freed += await removeById(id);
    if (db.files.length < before) removed++;
  }
  save();
  res.json({ ok: true, removed: removed, freed: freed, quota: quotaInfo() });
});

app.get('/healthz', (req, res) => {
  const q = quotaInfo();
  res.json({ ok: true, files: db.files.length, usedBytes: q.used, quotaBytes: q.bytes, percent: q.percent });
});

// خطاهای multer (مثل حجم زیاد)
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: 'خطای آپلود: ' + err.code + ' (سقف ' + MAX_FILE_MB + 'MB برای هر فایل)' });
  }
  console.error(err);
  res.status(500).json({ error: 'خطای سرور' });
});

app.listen(PORT, HOST, () => {
  const q = quotaInfo();
  console.log('──────────────────────────────────────────');
  console.log('  FileBox بالا آمد ✅');
  console.log('  آدرس محلی  : http://localhost:' + PORT);
  console.log('  مسیر داده  : ' + DATA_DIR);
  console.log('  سهمیه فضا  : ' + fmtGB(q.used) + ' از ' + QUOTA_GB + ' GB (' + q.percent + '%)');
  console.log('  کف دیسک    : ' + MIN_FREE_DISK_GB + ' GB');
  console.log('  رمز پنل    : ' + (ADMIN_PASSWORD === 'change-me-123' ? '⚠️  پیش‌فرض — حتماً عوضش کن!' : 'از ENV خوانده شد'));
  console.log('──────────────────────────────────────────');
});
