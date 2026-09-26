'use strict';

// ذخیره‌سازی روی گیت‌هاب
//
// فایل‌ها به صورت «release asset» ذخیره می‌شوند، نه commit معمولی:
//   - فایلی که از تاریخچه‌ی گیت پاک شود هنوز جا می‌گیرد، پس ریپو فقط بزرگ می‌شود.
//     asset واقعاً پاک می‌شود.
//   - سقف هر asset دو گیگابایت است؛ Contents API صد مگابایت.
//   - هر release حداکثر ۱۰۰۰ asset دارد، برای همین هر ماه یک release جدا
//     (files-YYYY-MM) ساخته می‌شود — که همان مرتب‌سازی ماهانه را هم می‌دهد.
//
// فراداده (db.json) و فهرست خوانا (INDEX.md) داخل خود ریپو commit می‌شوند
// تا هر سرور تازه‌ای بتواند فقط از روی ریپو بالا بیاید.

const fs = require('fs');
const https = require('https');
const path = require('path');
const { Readable } = require('stream');

const API = 'https://api.github.com';
const UPLOADS = 'uploads.github.com';

// زیر ۲ گیبی‌بایت طبق مستندات گیت‌هاب
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024 - 1;

function createGithubStore(opts) {
  const token = opts.token || '';
  const repo = opts.repo || '';
  const branch = opts.branch || 'main';
  const enabled = Boolean(token && /^[\w.-]+\/[\w.-]+$/.test(repo));

  const baseHeaders = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'filebox',
  };

  async function api(method, urlPath, body, extraHeaders) {
    const headers = Object.assign({}, baseHeaders, extraHeaders || {});
    const init = { method: method, headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(API + urlPath, init);
    return res;
  }

  async function apiJson(method, urlPath, body) {
    const res = await api(method, urlPath, body);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = { raw: text };
    }
    return { status: res.status, data: data };
  }

  function fail(msg, status) {
    const e = new Error(msg);
    e.status = status;
    return e;
  }

  // ---- وضعیت اتصال --------------------------------------------------------
  let lastCheck = { ok: false, error: 'هنوز بررسی نشده', at: 0 };

  async function check() {
    if (!enabled) {
      lastCheck = { ok: false, error: 'GITHUB_TOKEN یا GITHUB_REPO تنظیم نشده', at: Date.now() };
      return lastCheck;
    }
    try {
      const r = await apiJson('GET', '/repos/' + repo);
      if (r.status !== 200) {
        lastCheck = { ok: false, error: 'دسترسی به ریپو: HTTP ' + r.status, at: Date.now() };
      } else {
        lastCheck = {
          ok: true,
          private: Boolean(r.data.private),
          url: r.data.html_url,
          at: Date.now(),
        };
        if (!r.data.private) lastCheck.warning = 'ریپوی داده عمومی است — هر کسی فایل‌ها را می‌بیند';
      }
    } catch (e) {
      lastCheck = { ok: false, error: 'اتصال به گیت‌هاب برقرار نشد: ' + (e.cause && e.cause.code || e.message), at: Date.now() };
    }
    return lastCheck;
  }

  // ---- releaseهای ماهانه -------------------------------------------------
  const releaseCache = new Map(); // tag -> Promise<release>

  function ensureRelease(tag) {
    if (releaseCache.has(tag)) return releaseCache.get(tag);
    const p = (async () => {
      let r = await apiJson('GET', '/repos/' + repo + '/releases/tags/' + encodeURIComponent(tag));
      if (r.status === 200) return r.data;
      if (r.status !== 404) throw fail('خواندن release ' + tag + ': HTTP ' + r.status, r.status);

      const month = tag.replace(/^files-/, '');
      r = await apiJson('POST', '/repos/' + repo + '/releases', {
        tag_name: tag,
        target_commitish: branch,
        name: 'فایل‌های ' + month,
        body: 'فایل‌های آپلودشده در ' + month + ' — مدیریت‌شده توسط FileBox.\nفهرست کامل در INDEX.md.',
        draft: false,
        prerelease: false,
      });
      if (r.status === 201) return r.data;
      // اگر هم‌زمان آپلود دیگری ساخته باشدش
      if (r.status === 422) {
        const again = await apiJson('GET', '/repos/' + repo + '/releases/tags/' + encodeURIComponent(tag));
        if (again.status === 200) return again.data;
      }
      throw fail('ساخت release ' + tag + ': HTTP ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200), r.status);
    })();
    p.catch(() => releaseCache.delete(tag));
    releaseCache.set(tag, p);
    return p;
  }

  // ---- آپلود --------------------------------------------------------------
  // استریم مستقیم از دیسک؛ uploads.github.com طول بدنه را از قبل می‌خواهد.
  function postAsset(releaseId, assetName, label, localPath, size, contentType) {
    return new Promise((resolve, reject) => {
      const qs = 'name=' + encodeURIComponent(assetName) + (label ? '&label=' + encodeURIComponent(label) : '');
      const req = https.request(
        {
          method: 'POST',
          host: UPLOADS,
          path: '/repos/' + repo + '/releases/' + releaseId + '/assets?' + qs,
          headers: Object.assign({}, baseHeaders, {
            'Content-Type': contentType || 'application/octet-stream',
            'Content-Length': size,
          }),
          timeout: 10 * 60 * 1000,
        },
        (res) => {
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            let data = null;
            try {
              data = JSON.parse(buf);
            } catch (e) {
              data = { raw: buf.slice(0, 200) };
            }
            if (res.statusCode === 201) resolve(data);
            else reject(fail('آپلود asset: HTTP ' + res.statusCode + ' ' + JSON.stringify(data).slice(0, 200), res.statusCode));
          });
        }
      );
      req.on('timeout', () => req.destroy(fail('آپلود asset: timeout')));
      req.on('error', reject);
      fs.createReadStream(localPath).on('error', reject).pipe(req);
    });
  }

  function assetNameFor(rec) {
    // نام asset فقط ASCII؛ نام اصلی (فارسی) در label و در db می‌ماند
    const ext = (path.extname(rec.name).slice(1).toLowerCase().match(/^[a-z0-9]{1,10}$/) || [''])[0];
    const day = rec.createdAt.slice(0, 10);
    return rec.category + '_' + day + '_' + rec.id + (ext ? '.' + ext : '');
  }

  async function uploadFile(rec, localPath, tag) {
    if (!enabled) throw fail('گیت‌هاب تنظیم نشده');
    if (rec.size > MAX_ASSET_BYTES) throw fail('حجم فایل از سقف ۲ گیگابایتی گیت‌هاب بیشتر است');
    tag = tag || 'files-' + rec.createdAt.slice(0, 7);
    const release = await ensureRelease(tag);
    const assetName = assetNameFor(rec);
    const label = (rec.category + ' / ' + rec.name).slice(0, 200);
    const asset = await postAsset(release.id, assetName, label, localPath, rec.size, rec.mime);
    return {
      assetId: asset.id,
      releaseId: release.id,
      tag: tag,
      assetName: asset.name,
      assetUrl: asset.browser_download_url,
    };
  }

  // ---- دانلود -------------------------------------------------------------
  // گیت‌هاب به یک URL امضاشده‌ی موقت ریدایرکت می‌کند؛ fetch در ریدایرکت
  // به دامنه‌ی دیگر هدر Authorization را خودش حذف می‌کند.
  async function openDownload(assetId) {
    const res = await fetch(API + '/repos/' + repo + '/releases/assets/' + assetId, {
      headers: Object.assign({}, baseHeaders, { Accept: 'application/octet-stream' }),
      redirect: 'follow',
    });
    if (!res.ok) {
      throw fail('دانلود از گیت‌هاب: HTTP ' + res.status, res.status);
    }
    return {
      stream: Readable.fromWeb(res.body),
      size: parseInt(res.headers.get('content-length') || '0', 10) || null,
    };
  }

  async function downloadToFile(assetId, destPath) {
    const d = await openDownload(assetId);
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(destPath);
      d.stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      d.stream.pipe(out);
    });
  }

  async function deleteAsset(assetId) {
    const res = await api('DELETE', '/repos/' + repo + '/releases/assets/' + assetId);
    // ۴۰۴ یعنی از قبل نبوده — برای ما همان نتیجه است
    if (res.status !== 204 && res.status !== 404) {
      throw fail('حذف از گیت‌هاب: HTTP ' + res.status, res.status);
    }
  }

  // ---- فایل‌های متنی داخل ریپو (db.json و INDEX.md) ----------------------
  const shaCache = new Map();

  async function getText(filePath) {
    const url = '/repos/' + repo + '/contents/' + encodeURI(filePath) + '?ref=' + encodeURIComponent(branch);
    const meta = await apiJson('GET', url);
    if (meta.status === 404) return null;
    if (meta.status !== 200) throw fail('خواندن ' + filePath + ': HTTP ' + meta.status, meta.status);
    shaCache.set(filePath, meta.data.sha);

    // بالای ۱ مگابایت فیلد content خالی برمی‌گردد؛ نسخه‌ی خام را جدا می‌گیریم
    if (meta.data.content && meta.data.encoding === 'base64') {
      return Buffer.from(meta.data.content, 'base64').toString('utf8');
    }
    const raw = await api('GET', url, undefined, { Accept: 'application/vnd.github.raw' });
    if (!raw.ok) throw fail('خواندن خام ' + filePath + ': HTTP ' + raw.status, raw.status);
    return await raw.text();
  }

  async function putText(filePath, text, message) {
    const url = '/repos/' + repo + '/contents/' + encodeURI(filePath);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!shaCache.has(filePath)) {
        const meta = await apiJson('GET', url + '?ref=' + encodeURIComponent(branch));
        if (meta.status === 200) shaCache.set(filePath, meta.data.sha);
        else if (meta.status === 404) shaCache.set(filePath, null);
        else throw fail('خواندن sha ' + filePath + ': HTTP ' + meta.status, meta.status);
      }
      const body = {
        message: message,
        content: Buffer.from(text, 'utf8').toString('base64'),
        branch: branch,
      };
      const sha = shaCache.get(filePath);
      if (sha) body.sha = sha;

      const r = await apiJson('PUT', url, body);
      if (r.status === 200 || r.status === 201) {
        shaCache.set(filePath, r.data.content.sha);
        return;
      }
      // sha قدیمی بود (کسی دیگری نوشته) — یک بار دیگر با sha تازه
      if (r.status === 409 || r.status === 422) {
        shaCache.delete(filePath);
        continue;
      }
      throw fail('نوشتن ' + filePath + ': HTTP ' + r.status, r.status);
    }
    throw fail('نوشتن ' + filePath + ': تعارض sha بعد از تلاش دوباره');
  }

  return {
    enabled: enabled,
    repo: repo,
    branch: branch,
    maxAssetBytes: MAX_ASSET_BYTES,
    status: () => lastCheck,
    check: check,
    uploadFile: uploadFile,
    openDownload: openDownload,
    downloadToFile: downloadToFile,
    deleteAsset: deleteAsset,
    getText: getText,
    putText: putText,
  };
}

module.exports = { createGithubStore };
