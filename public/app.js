/* FileBox — رابط کاربری */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var cfg = { uploadProtected: false, maxFileMB: 2048, loggedIn: false, quota: null, githubQuota: null, storage: null };
  var selected = new Set();
  var lastData = null;

  var nick = $('#nick');
  try { nick.value = localStorage.getItem('fb_nick') || ''; } catch (e) {}
  nick.addEventListener('input', function () { try { localStorage.setItem('fb_nick', nick.value); } catch (e) {} });
  function who() { return nick.value.trim() || 'ناشناس'; }

  // اندازه‌ها لاتین‌اند؛ داخل متن راست‌به‌چپ جابه‌جا نمایش داده می‌شوند (B 18)
  // مگر با LRI/PDI جدا شوند
  function ltr(s) { return '⁦' + s + '⁩'; }
  function fmtSize(b) {
    if (!b) return ltr('0 B');
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(b) / Math.log(1024));
    return ltr((b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i]);
  }
  function fmtTime(iso) {
    return new Date(iso).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
  }
  function ago(iso) {
    if (!iso) return '—';
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'همین الان';
    if (s < 3600) return Math.round(s / 60) + ' دقیقه پیش';
    if (s < 86400) return Math.round(s / 3600) + ' ساعت پیش';
    return fmtTime(iso);
  }
  var ICONS = { image: '🖼️', video: '🎬', audio: '🎵', document: '📄', archive: '🗜️', code: '💻', other: '📎' };
  var LABELS = { image: 'تصویر', video: 'ویدیو', audio: 'صدا', document: 'سند', archive: 'آرشیو', code: 'کد', other: 'سایر' };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function quotaClass(p) { return p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok'; }
  function bar(q) {
    return '<div class="bar big"><i class="' + quotaClass(q.percent) + '" style="width:' + q.percent + '%"></i></div>';
  }
  function jsonPost(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  // ---------------- تب‌ها ----------------
  var tabs = document.querySelectorAll('.tab');
  function showTab(name) {
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    document.querySelectorAll('.page').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + name);
    });
    location.hash = name;
    if (name === 'panel' && cfg.loggedIn) loadFiles();
  }
  tabs.forEach(function (t) { t.onclick = function () { showTab(t.dataset.tab); }; });

  // ---------------- نوار فضا در تب آپلود ----------------
  // نوار مربوط به مقصد فعلی را نشان می‌دهد
  function renderQuotaMini() {
    var toGh = cfg.storage && cfg.storage.target === 'github' && cfg.githubQuota;
    var q = toGh ? cfg.githubQuota : cfg.quota;
    if (!q) return;
    var dest = toGh ? '☁️ فایل‌ها در گیت‌هاب ذخیره می‌شوند' : '🖥️ فایل‌ها روی همین سرور ذخیره می‌شوند';
    $('#quotaMini').innerHTML =
      '<div class="qrow"><span>' + dest + '</span>' +
      '<b>' + fmtSize(q.used) + ' از ' + ltr(q.gb + ' GB') + '</b></div>' + bar(q) +
      (q.full ? '<div class="err">فضا پر است — تا وقتی ادمین چیزی پاک نکند آپلود ممکن نیست.</div>'
              : '<div class="muted small">' + fmtSize(q.remaining) + ' باقی مانده</div>');
  }

  // ---------------- پنل: ذخیره‌سازی ----------------
  function renderStorage(d) {
    var q = d.quota;
    $('#quotaBig').innerHTML =
      '<div class="qstat"><div class="big-num ' + quotaClass(q.percent) + '">' + q.percent + '%</div>' +
      '<div><div><b>' + fmtSize(q.used) + '</b> از ' + ltr(q.gb + ' GB') + '</div>' +
      '<div class="muted small">' + fmtSize(q.remaining) + ' باقی مانده</div></div></div>' + bar(q);

    if (d.disk) {
      var low = d.disk.free < (d.minFreeDiskGB || 2) * 1024 * 1024 * 1024;
      $('#diskInfo').innerHTML =
        'فضای آزاد دیسک: <b' + (low ? ' class="crit"' : '') + '>' + fmtSize(d.disk.free) +
        '</b> از ' + fmtSize(d.disk.total) + ' · کف مجاز ' + ltr((d.minFreeDiskGB || 2) + ' GB') +
        (low ? '<br><span class="crit">آپلود تا آزاد شدن فضا غیرفعال است</span>' : '');
    }

    var g = d.github;
    if (!g) {
      $('#ghQuota').innerHTML = '<p class="muted small">گیت‌هاب روی این سرور تنظیم نشده. برای فعال شدن ' +
        '<code>GITHUB_TOKEN</code> و <code>GITHUB_REPO</code> را تنظیم کنید.</p>';
      $('#ghInfo').innerHTML = '';
    } else {
      var gq = d.githubQuota;
      $('#ghQuota').innerHTML =
        '<div class="qstat"><div class="big-num ' + quotaClass(gq.percent) + '">' + gq.percent + '%</div>' +
        '<div><div><b>' + fmtSize(gq.used) + '</b> از ' + ltr(gq.gb + ' GB') + '</div>' +
        '<div class="muted small">' + fmtSize(gq.remaining) + ' باقی مانده</div></div></div>' + bar(gq);
      var conn = g.ok ? '<span class="okc">● متصل</span>' : '<span class="crit">● قطع — ' + esc(g.error || '') + '</span>';
      var sync = !g.sync || g.sync.ok === null ? 'هنوز همگام نشده'
        : g.sync.ok ? 'آخرین همگام‌سازی فهرست: ' + ago(g.sync.at)
        : '<span class="crit">همگام‌سازی فهرست ناموفق: ' + esc(g.sync.error || '') + '</span>';
      $('#ghInfo').innerHTML =
        conn + ' · <a href="' + esc(g.url) + '" target="_blank" rel="noopener">' + esc(g.repo) + '</a><br>' + sync +
        (g.queue ? '<br>⏳ ' + g.queue + ' فایل در صف انتقال' : '') +
        (g.warning ? '<br><span class="crit">⚠️ ' + esc(g.warning) + '</span>' : '');
    }

    // انتخاب مقصد
    var tb = $('#targetBox');
    tb.classList.toggle('hidden', !g);
    document.querySelectorAll('.gh-only').forEach(function (b) { b.classList.toggle('hidden', !g); });
    if (g) {
      tb.querySelectorAll('.seg button').forEach(function (b) {
        b.classList.toggle('on', b.dataset.target === d.storage.target);
      });
      $('#targetNote').textContent = d.storage.target === 'github'
        ? 'اگر گیت‌هاب در دسترس نباشد، فایل روی سرور می‌ماند و بعداً می‌توانید منتقلش کنید.'
        : 'فایل‌ها فقط روی همین سرور ذخیره می‌شوند.';
    }

    var cats = Object.keys(d.sizes || {}).sort(function (a, b) { return d.sizes[b] - d.sizes[a]; });
    $('#catBars').innerHTML = cats.map(function (c) {
      var pct = d.totalSize ? (d.sizes[c] / d.totalSize * 100) : 0;
      return '<div class="cat-bar"><div class="cl">' + ICONS[c] + ' ' + LABELS[c] +
        ' <span class="muted small">(' + d.counts[c] + ')</span></div>' +
        '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
        '<div class="cs">' + fmtSize(d.sizes[c]) + '</div></div>';
    }).join('') || '<p class="muted small">هنوز فایلی نیست.</p>';
  }

  document.querySelectorAll('#targetBox .seg button').forEach(function (b) {
    b.onclick = function () {
      jsonPost('/api/settings', { target: b.dataset.target }).then(function (d) {
        if (d.error) return alert(d.error);
        cfg.storage = d.storage;
        loadFiles();
      });
    };
  });

  // ---------------- آپلود ----------------
  var drop = $('#drop'), fileInput = $('#fileInput'), queueEl = $('#queue');
  var btnUpload = $('#btnUpload'), upStatus = $('#upStatus');
  var queue = [];

  drop.onclick = function () { fileInput.click(); };
  ['dragenter', 'dragover'].forEach(function (e) {
    drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (e) {
    drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (ev) { addFiles(ev.dataTransfer.files); });
  fileInput.onchange = function () { addFiles(fileInput.files); fileInput.value = ''; };

  function addFiles(list) {
    for (var i = 0; i < list.length; i++) queue.push(list[i]);
    renderQueue();
  }
  function extCat(name) {
    var e = (name.split('.').pop() || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif'].indexOf(e) > -1) return 'image';
    if (['mp4', 'mkv', 'mov', 'avi', 'webm'].indexOf(e) > -1) return 'video';
    if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].indexOf(e) > -1) return 'audio';
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md', 'csv'].indexOf(e) > -1) return 'document';
    if (['zip', 'rar', '7z', 'tar', 'gz'].indexOf(e) > -1) return 'archive';
    if (['js', 'ts', 'py', 'go', 'sh', 'json', 'html', 'css'].indexOf(e) > -1) return 'code';
    return 'other';
  }
  function renderQueue() {
    var total = queue.reduce(function (s, f) { return s + f.size; }, 0);
    queueEl.innerHTML = queue.map(function (f, i) {
      return '<div class="qitem"><span>' + ICONS[extCat(f.name)] + '</span>' +
        '<span class="nm">' + esc(f.name) + '</span>' +
        '<span class="muted small">' + fmtSize(f.size) + '</span>' +
        '<span class="x" data-i="' + i + '">✕</span></div>';
    }).join('');
    if (queue.length) {
      var warn = '';
      if (cfg.quota && total > cfg.quota.remaining) {
        warn = '<div class="err">این حجم از فضای باقی‌مانده بیشتر است و رد خواهد شد.</div>';
      }
      queueEl.innerHTML += '<div class="muted small">مجموع: ' + fmtSize(total) + '</div>' + warn;
    }
    queueEl.querySelectorAll('.x').forEach(function (x) {
      x.onclick = function () { queue.splice(+x.dataset.i, 1); renderQueue(); };
    });
    btnUpload.disabled = queue.length === 0;
  }

  $('#btnClearQueue').onclick = function () { queue = []; renderQueue(); upStatus.textContent = ''; };

  function applyQuotas(d) {
    if (d.quota) cfg.quota = d.quota;
    if (d.githubQuota) cfg.githubQuota = d.githubQuota;
    renderQuotaMini();
  }

  btnUpload.onclick = function () {
    if (!queue.length) return;
    var fd = new FormData();
    fd.append('uploader', who());
    queue.forEach(function (f) { fd.append('files', f); });

    var pbar = document.createElement('div');
    pbar.className = 'bar big';
    pbar.innerHTML = '<i></i>';
    queueEl.after(pbar);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    var up = $('#upPass').value;
    if (up) xhr.setRequestHeader('X-Upload-Password', up);
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) pbar.firstChild.style.width = (e.loaded / e.total * 100) + '%';
    };
    xhr.onload = function () {
      pbar.remove();
      btnUpload.disabled = false;
      var d = {};
      try { d = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status === 200) {
        upStatus.textContent = '✅ ' + queue.length + ' فایل آپلود شد' +
          (d.target === 'github' ? ' — در حال انتقال به گیت‌هاب' : '');
        queue = [];
        applyQuotas(d);
        renderQueue();
      } else {
        upStatus.textContent = '❌ ' + (d.error || 'خطا');
        applyQuotas(d);
      }
    };
    xhr.onerror = function () { pbar.remove(); btnUpload.disabled = false; upStatus.textContent = '❌ اتصال قطع شد'; };
    btnUpload.disabled = true;
    upStatus.textContent = 'در حال ارسال...';
    xhr.send(fd);
  };

  // ---------------- چت ----------------
  var messagesEl = $('#messages'), chatFile = $('#chatFile'), attachEl = $('#chatAttach');
  var lastSeq = 0, chatAttached = null;

  chatFile.onchange = function () {
    chatAttached = chatFile.files[0] || null;
    if (chatAttached) {
      attachEl.classList.remove('hidden');
      attachEl.innerHTML = '<span>📎 ' + esc(chatAttached.name) + ' (' + fmtSize(chatAttached.size) + ')</span><span id="rmAtt" style="cursor:pointer">✕</span>';
      $('#rmAtt').onclick = clearAttach;
    } else clearAttach();
  };
  function clearAttach() {
    chatAttached = null; chatFile.value = '';
    attachEl.classList.add('hidden'); attachEl.innerHTML = '';
  }

  $('#chatForm').onsubmit = function (e) {
    e.preventDefault();
    var text = $('#chatText').value;
    if (!text.trim() && !chatAttached) return;
    var fd = new FormData();
    fd.append('name', who());
    fd.append('text', text);
    if (chatAttached) fd.append('file', chatAttached);

    var headers = {};
    var up = $('#upPass').value;
    if (up) headers['X-Upload-Password'] = up;

    $('#chatText').value = '';
    clearAttach();

    fetch('/api/messages', { method: 'POST', body: fd, headers: headers })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.error) alert(d.error); poll(); })
      .catch(function () { alert('ارسال ناموفق'); });
  };

  function renderMsg(m) {
    var mine = m.name === who();
    var div = document.createElement('div');
    div.className = 'msg' + (mine ? ' me' : '');
    var html = '<div class="meta">' + esc(m.name) + ' · ' + fmtTime(m.at) + '</div>';
    if (m.text) html += '<div>' + esc(m.text).replace(/\n/g, '<br>') + '</div>';
    if (m.file) {
      html += '<div class="fchip"><span>' + (ICONS[m.file.category] || '📎') + '</span>' +
        '<span style="flex:1;overflow:hidden;text-overflow:ellipsis">' + esc(m.file.name) + '</span>' +
        '<span class="small">' + fmtSize(m.file.size) + '</span>' +
        '<a href="/api/download/' + m.file.id + '" style="color:inherit">⬇️</a></div>';
    }
    div.innerHTML = html;
    messagesEl.appendChild(div);
  }

  function poll() {
    fetch('/api/messages?since=' + lastSeq)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.messages && d.messages.length) {
          var atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
          d.messages.forEach(renderMsg);
          lastSeq = d.last;
          if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      })
      .catch(function () {});
  }
  setInterval(poll, 2500);

  // ---------------- پنل ----------------
  var curCat = '', curQ = '', curSort = 'new', curWhere = '';
  var refreshTimer = null;

  $('#loginForm').onsubmit = function (e) {
    e.preventDefault();
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#pass').value }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) {
          cfg.loggedIn = true;
          $('#pass').value = '';
          $('#loginErr').textContent = '';
          $('#loginBox').classList.add('hidden');
          $('#panelBox').classList.remove('hidden');
          loadFiles();
        } else $('#loginErr').textContent = res.d.error || 'خطا';
      });
  };

  $('#btnLogout').onclick = function () {
    fetch('/api/logout', { method: 'POST' }).then(function () {
      cfg.loggedIn = false;
      $('#panelBox').classList.add('hidden');
      $('#loginBox').classList.remove('hidden');
    });
  };

  var searchTimer = null;
  $('#search').oninput = function (e) {
    clearTimeout(searchTimer);
    curQ = e.target.value;
    searchTimer = setTimeout(loadFiles, 250);
  };
  $('#sort').onchange = function (e) { curSort = e.target.value; loadFiles(); };

  // --- انتخاب گروهی ---
  function selectedFiles() {
    if (!lastData) return [];
    return lastData.files.filter(function (f) { return selected.has(f.id); });
  }
  function syncSel() {
    var files = selectedFiles();
    var bytes = files.reduce(function (s, f) { return s + (f.size || 0); }, 0);
    var n = files.length;
    $('#selInfo').textContent = n ? n + ' فایل انتخاب شده · ' + fmtSize(bytes) : 'چیزی انتخاب نشده';
    $('#btnZipSel').disabled = !n;
    $('#btnDelSel').disabled = !n;
    $('#btnToGh').disabled = !files.some(function (f) { return f.backend === 'local' && !f.missing && f.sync !== 'pending'; });
    $('#btnToLocal').disabled = !files.some(function (f) { return f.backend === 'github' && f.sync !== 'pending'; });
    var boxes = document.querySelectorAll('.pickone');
    $('#selAll').checked = boxes.length > 0 && [].every.call(boxes, function (b) { return b.checked; });
  }

  $('#selAll').onchange = function (e) {
    document.querySelectorAll('.pickone').forEach(function (b) {
      b.checked = e.target.checked;
      if (e.target.checked) selected.add(b.dataset.id); else selected.delete(b.dataset.id);
    });
    syncSel();
  };

  $('#btnZipSel').onclick = function () {
    if (!selected.size) return;
    location.href = '/api/zip?ids=' + [].slice.call(selected).join(',');
  };

  $('#btnDelSel').onclick = function () {
    var ids = [].slice.call(selected);
    if (!ids.length) return;
    if (!confirm('حذف ' + ids.length + ' فایل؟ این کار برگشت‌پذیر نیست — از گیت‌هاب هم پاک می‌شوند.')) return;
    jsonPost('/api/files/bulk-delete', { ids: ids }).then(function (d) {
      if (d.error) return alert(d.error);
      selected.clear();
      var msg = '✅ ' + d.removed + ' فایل حذف شد — ' + fmtSize(d.freed) + ' آزاد شد';
      if (d.failed) msg += '\n⚠️ ' + d.failed + ' فایل حذف نشد: ' + (d.errors || []).join(' | ');
      alert(msg);
      loadFiles();
    });
  };

  function move(to) {
    var ids = selectedFiles().filter(function (f) {
      return to === 'github' ? f.backend === 'local' && !f.missing : f.backend === 'github';
    }).map(function (f) { return f.id; });
    if (!ids.length) return;
    jsonPost('/api/files/move', { ids: ids, to: to }).then(function (d) {
      if (d.error) return alert(d.error);
      selected.clear();
      loadFiles();
    });
  }
  $('#btnToGh').onclick = function () { move('github'); };
  $('#btnToLocal').onclick = function () { move('local'); };

  function locBadge(f) {
    if (f.sync === 'pending') {
      return '<span class="badge pend">⏳ ' + (f.syncDir === 'toLocal' ? 'در حال انتقال به سرور' : 'در حال انتقال به گیت‌هاب') + '</span>';
    }
    var b = f.backend === 'github'
      ? '<span class="badge gh">☁️ گیت‌هاب</span>'
      : f.missing
        ? '<span class="badge bad" title="این فایل روی سرور دیگری آپلود شده و اینجا نیست">❌ روی این سرور نیست</span>'
        : '<span class="badge loc">🖥️ سرور</span>';
    if (f.sync === 'failed') {
      b += ' <span class="badge bad" title="' + esc(f.syncError || '') + '">⚠️ انتقال ناموفق</span>';
    }
    return b;
  }

  function loadFiles() {
    clearTimeout(refreshTimer);
    var qs = 'q=' + encodeURIComponent(curQ) + '&category=' + curCat + '&sort=' + curSort + '&where=' + curWhere;
    fetch('/api/files?' + qs)
      .then(function (r) {
        if (r.status === 401) {
          cfg.loggedIn = false;
          $('#panelBox').classList.add('hidden');
          $('#loginBox').classList.remove('hidden');
          throw new Error('auth');
        }
        return r.json();
      })
      .then(function (d) {
        lastData = d;
        cfg.quota = d.quota;
        cfg.githubQuota = d.githubQuota;
        cfg.storage = d.storage;
        renderStorage(d);
        renderQuotaMini();

        var cats = ['', 'image', 'video', 'audio', 'document', 'archive', 'code', 'other'];
        $('#cats').innerHTML = cats.filter(function (c) { return c === '' || d.counts[c]; })
          .map(function (c) {
            var label = c ? ICONS[c] + ' ' + LABELS[c] + ' (' + d.counts[c] + ')' : 'همه (' + d.total + ')';
            return '<span class="chip' + (c === curCat ? ' on' : '') + '" data-c="' + c + '">' + label + '</span>';
          }).join('');
        $('#cats').querySelectorAll('.chip').forEach(function (ch) {
          ch.onclick = function () { curCat = ch.dataset.c; selected.clear(); loadFiles(); };
        });

        if (d.github) {
          var wheres = [['', 'همه جا'], ['github', '☁️ گیت‌هاب'], ['local', '🖥️ سرور']];
          $('#wheres').innerHTML = wheres.map(function (w) {
            return '<span class="chip small-chip' + (w[0] === curWhere ? ' on' : '') + '" data-w="' + w[0] + '">' + w[1] + '</span>';
          }).join('');
          $('#wheres').querySelectorAll('.chip').forEach(function (ch) {
            ch.onclick = function () { curWhere = ch.dataset.w; selected.clear(); loadFiles(); };
          });
        } else {
          $('#wheres').innerHTML = '';
        }

        if (!d.files.length) {
          $('#fileList').innerHTML = '<p class="muted">فایلی پیدا نشد.</p>';
          syncSel();
        } else {
          $('#fileList').innerHTML = d.files.map(function (f) {
            var dead = f.missing;
            return '<div class="frow' + (dead ? ' dead' : '') + '">' +
              '<input type="checkbox" class="pickone" data-id="' + f.id + '"' + (selected.has(f.id) ? ' checked' : '') + '>' +
              '<span class="ic">' + (ICONS[f.category] || '📎') + '</span>' +
              '<div class="info"><div class="nm">' + esc(f.name) + '</div>' +
              '<div class="sub">' + fmtSize(f.size) + ' · ' + esc(f.uploader) + ' · ' + fmtTime(f.createdAt) +
              (f.source === 'chat' ? ' · از چت' : '') + '</div>' +
              '<div class="loc">' + locBadge(f) + '</div></div>' +
              (dead ? '' :
                '<a href="/api/view/' + f.id + '" target="_blank" title="پیش‌نمایش">👁️</a>' +
                '<a href="/api/download/' + f.id + '" title="دانلود">⬇️</a>') +
              '<button class="del" data-id="' + f.id + '" data-n="' + esc(f.name) + '" title="حذف">🗑️</button>' +
              '</div>';
          }).join('');

          $('#fileList').querySelectorAll('.pickone').forEach(function (b) {
            b.onchange = function () {
              if (b.checked) selected.add(b.dataset.id); else selected.delete(b.dataset.id);
              syncSel();
            };
          });
          $('#fileList').querySelectorAll('.del').forEach(function (b) {
            b.onclick = function () {
              if (!confirm('حذف «' + b.dataset.n + '» ؟')) return;
              fetch('/api/files/' + b.dataset.id, { method: 'DELETE' })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                  if (res.error) alert(res.error);
                  selected.delete(b.dataset.id);
                  loadFiles();
                });
            };
          });
          syncSel();
        }

        // تا وقتی چیزی در حال انتقال است، پنل خودش تازه می‌شود
        var busy = (d.github && d.github.queue) || d.files.some(function (f) { return f.sync === 'pending'; });
        if (busy && cfg.loggedIn) refreshTimer = setTimeout(loadFiles, 3000);
      })
      .catch(function () {});
  }

  // ---------------- راه‌اندازی ----------------
  fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
    cfg = c;
    if (c.uploadProtected) $('#upPassWrap').classList.remove('hidden');
    if (c.loggedIn) {
      $('#loginBox').classList.add('hidden');
      $('#panelBox').classList.remove('hidden');
    }
    renderQuotaMini();
    $('#hostInfo').textContent = location.origin;
    var h = (location.hash || '#upload').slice(1);
    showTab(['upload', 'chat', 'panel'].indexOf(h) > -1 ? h : 'upload');
    poll();
  });
})();
