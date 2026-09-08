/* FileBox — رابط کاربری */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var cfg = { uploadProtected: false, maxFileMB: 2048, loggedIn: false, quota: null };
  var selected = new Set();
  var lastData = null;

  var nick = $('#nick');
  nick.value = localStorage.getItem('fb_nick') || '';
  nick.addEventListener('input', function () { localStorage.setItem('fb_nick', nick.value); });
  function who() { return nick.value.trim() || 'ناشناس'; }

  function fmtSize(b) {
    if (!b) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
  }
  function fmtTime(iso) {
    return new Date(iso).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
  }
  var ICONS = { image: '🖼️', video: '🎬', audio: '🎵', document: '📄', archive: '🗜️', code: '💻', other: '📎' };
  var LABELS = { image: 'تصویر', video: 'ویدیو', audio: 'صدا', document: 'سند', archive: 'آرشیو', code: 'کد', other: 'سایر' };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function quotaClass(p) { return p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok'; }

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

  // ---------------- نوار سهمیه ----------------
  function renderQuotaMini(q) {
    if (!q) return;
    $('#quotaMini').innerHTML =
      '<div class="qrow"><span>فضای مصرف‌شده</span>' +
      '<b>' + fmtSize(q.used) + ' از ' + q.gb + ' GB</b></div>' +
      '<div class="bar big"><i class="' + quotaClass(q.percent) + '" style="width:' + q.percent + '%"></i></div>' +
      (q.full ? '<div class="err">فضا پر است — تا وقتی ادمین چیزی پاک نکند آپلود ممکن نیست.</div>'
              : '<div class="muted small">' + fmtSize(q.remaining) + ' باقی مانده</div>');
  }

  function renderQuotaBig(d) {
    var q = d.quota;
    $('#quotaBig').innerHTML =
      '<div class="qstat"><div class="big-num ' + quotaClass(q.percent) + '">' + q.percent + '%</div>' +
      '<div><div><b>' + fmtSize(q.used) + '</b> از ' + q.gb + ' GB مصرف شده</div>' +
      '<div class="muted small">' + fmtSize(q.remaining) + ' باقی مانده · ' + d.total + ' فایل</div></div></div>' +
      '<div class="bar big"><i class="' + quotaClass(q.percent) + '" style="width:' + q.percent + '%"></i></div>';

    if (d.disk) {
      var low = d.disk.free < (d.minFreeDiskGB || 2) * 1024 * 1024 * 1024;
      $('#diskInfo').innerHTML =
        'فضای آزاد کل دیسک سرور: <b' + (low ? ' class="crit"' : '') + '>' + fmtSize(d.disk.free) +
        '</b> از ' + fmtSize(d.disk.total) +
        ' · کف مجاز ' + (d.minFreeDiskGB || 2) + ' GB' +
        (low ? ' — <span class="crit">آپلود تا آزاد شدن فضا غیرفعال است</span>' : '');
    }

    var cats = Object.keys(d.sizes || {}).sort(function (a, b) { return d.sizes[b] - d.sizes[a]; });
    $('#catBars').innerHTML = cats.map(function (c) {
      var pct = q.used ? (d.sizes[c] / q.used * 100) : 0;
      return '<div class="cat-bar"><div class="cl">' + ICONS[c] + ' ' + LABELS[c] +
        ' <span class="muted small">(' + d.counts[c] + ')</span></div>' +
        '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
        '<div class="cs">' + fmtSize(d.sizes[c]) + '</div></div>';
    }).join('') || '<p class="muted small">هنوز فایلی نیست.</p>';
  }

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

  btnUpload.onclick = function () {
    if (!queue.length) return;
    var fd = new FormData();
    fd.append('uploader', who());
    queue.forEach(function (f) { fd.append('files', f); });

    var bar = document.createElement('div');
    bar.className = 'bar big';
    bar.innerHTML = '<i></i>';
    queueEl.after(bar);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    var up = $('#upPass').value;
    if (up) xhr.setRequestHeader('X-Upload-Password', up);
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) bar.firstChild.style.width = (e.loaded / e.total * 100) + '%';
    };
    xhr.onload = function () {
      bar.remove();
      btnUpload.disabled = false;
      var d = {};
      try { d = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status === 200) {
        upStatus.textContent = '✅ ' + queue.length + ' فایل آپلود شد';
        queue = [];
        if (d.quota) { cfg.quota = d.quota; renderQuotaMini(d.quota); }
        renderQueue();
      } else {
        upStatus.textContent = '❌ ' + (d.error || 'خطا');
        if (d.quota) { cfg.quota = d.quota; renderQuotaMini(d.quota); }
      }
    };
    xhr.onerror = function () { bar.remove(); btnUpload.disabled = false; upStatus.textContent = '❌ اتصال قطع شد'; };
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
  var curCat = '', curQ = '', curSort = 'new';

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
  function syncSel() {
    var n = selected.size;
    var bytes = 0;
    if (lastData) {
      lastData.files.forEach(function (f) { if (selected.has(f.id)) bytes += f.size || 0; });
    }
    $('#selInfo').textContent = n ? n + ' فایل انتخاب شده · ' + fmtSize(bytes) : 'چیزی انتخاب نشده';
    $('#btnZipSel').disabled = !n;
    $('#btnDelSel').disabled = !n;
    var boxes = document.querySelectorAll('.pickone');
    var allOn = boxes.length > 0 && [].every.call(boxes, function (b) { return b.checked; });
    $('#selAll').checked = allOn;
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
    if (!confirm('حذف ' + ids.length + ' فایل؟ این کار برگشت‌پذیر نیست.')) return;
    fetch('/api/files/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) return alert(d.error);
        selected.clear();
        alert('✅ ' + d.removed + ' فایل حذف شد — ' + fmtSize(d.freed) + ' آزاد شد');
        loadFiles();
      });
  };

  function loadFiles() {
    fetch('/api/files?q=' + encodeURIComponent(curQ) + '&category=' + curCat + '&sort=' + curSort)
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
        renderQuotaBig(d);
        renderQuotaMini(d.quota);

        var cats = ['', 'image', 'video', 'audio', 'document', 'archive', 'code', 'other'];
        $('#cats').innerHTML = cats.filter(function (c) { return c === '' || d.counts[c]; })
          .map(function (c) {
            var label = c ? ICONS[c] + ' ' + LABELS[c] + ' (' + d.counts[c] + ')' : 'همه (' + d.total + ')';
            return '<span class="chip' + (c === curCat ? ' on' : '') + '" data-c="' + c + '">' + label + '</span>';
          }).join('');
        $('#cats').querySelectorAll('.chip').forEach(function (ch) {
          ch.onclick = function () { curCat = ch.dataset.c; selected.clear(); loadFiles(); };
        });

        if (!d.files.length) {
          $('#fileList').innerHTML = '<p class="muted">فایلی پیدا نشد.</p>';
          syncSel();
          return;
        }
        $('#fileList').innerHTML = d.files.map(function (f) {
          return '<div class="frow">' +
            '<input type="checkbox" class="pickone" data-id="' + f.id + '"' + (selected.has(f.id) ? ' checked' : '') + '>' +
            '<span class="ic">' + (ICONS[f.category] || '📎') + '</span>' +
            '<div class="info"><div class="nm">' + esc(f.name) + '</div>' +
            '<div class="sub">' + fmtSize(f.size) + ' · ' + esc(f.uploader) + ' · ' + fmtTime(f.createdAt) +
            (f.source === 'chat' ? ' · از چت' : '') + '</div></div>' +
            '<a href="/api/view/' + f.id + '" target="_blank" title="پیش‌نمایش">👁️</a>' +
            '<a href="/api/download/' + f.id + '" title="دانلود">⬇️</a>' +
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
              .then(function () { selected.delete(b.dataset.id); loadFiles(); });
          };
        });
        syncSel();
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
    renderQuotaMini(c.quota);
    $('#hostInfo').textContent = location.origin;
    var h = (location.hash || '#upload').slice(1);
    showTab(['upload', 'chat', 'panel'].indexOf(h) > -1 ? h : 'upload');
    poll();
  });
})();
