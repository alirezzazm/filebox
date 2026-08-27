/* FileBox — رابط کاربری */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var cfg = { uploadProtected: false, maxFileMB: 2048, loggedIn: false };

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
    var d = new Date(iso);
    return d.toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short' });
  }
  var ICONS = { image: '🖼️', video: '🎬', audio: '🎵', document: '📄', archive: '🗜️', code: '💻', other: '📎' };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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
  function renderQueue() {
    queueEl.innerHTML = queue.map(function (f, i) {
      return '<div class="qitem"><span>' + ICONS[extCat(f.name)] + '</span>' +
        '<span class="nm">' + esc(f.name) + '</span>' +
        '<span class="muted small">' + fmtSize(f.size) + '</span>' +
        '<span class="x" data-i="' + i + '">✕</span></div>';
    }).join('');
    queueEl.querySelectorAll('.x').forEach(function (x) {
      x.onclick = function () { queue.splice(+x.dataset.i, 1); renderQueue(); };
    });
    btnUpload.disabled = queue.length === 0;
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

  $('#btnClearQueue').onclick = function () { queue = []; renderQueue(); upStatus.textContent = ''; };

  btnUpload.onclick = function () {
    if (!queue.length) return;
    var fd = new FormData();
    fd.append('uploader', who());
    queue.forEach(function (f) { fd.append('files', f); });

    var bar = document.createElement('div');
    bar.className = 'bar';
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
      if (xhr.status === 200) {
        var n = queue.length;
        queue = []; renderQueue();
        upStatus.textContent = '✅ ' + n + ' فایل آپلود شد';
      } else {
        var msg = 'خطا';
        try { msg = JSON.parse(xhr.responseText).error; } catch (e) {}
        upStatus.textContent = '❌ ' + msg;
      }
    };
    xhr.onerror = function () { bar.remove(); upStatus.textContent = '❌ اتصال قطع شد'; };
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
    var sending = chatAttached; clearAttach();

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
        } else if (d.last != null) lastSeq = Math.max(lastSeq, 0);
      })
      .catch(function () {});
  }
  setInterval(poll, 2500);

  // ---------------- پنل ----------------
  var curCat = '', curQ = '';

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

  $('#btnZipAll').onclick = function () {
    location.href = '/api/zip' + (curCat ? '?category=' + curCat : '');
  };

  function loadFiles() {
    fetch('/api/files?q=' + encodeURIComponent(curQ) + '&category=' + curCat)
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
        $('#stats').textContent = 'مجموع: ' + d.total + ' فایل — ' + fmtSize(d.totalSize);

        var cats = ['', 'image', 'video', 'audio', 'document', 'archive', 'code', 'other'];
        var labels = { '': 'همه', image: 'تصویر', video: 'ویدیو', audio: 'صدا', document: 'سند', archive: 'آرشیو', code: 'کد', other: 'سایر' };
        $('#cats').innerHTML = cats.filter(function (c) { return c === '' || d.counts[c]; })
          .map(function (c) {
            return '<span class="chip' + (c === curCat ? ' on' : '') + '" data-c="' + c + '">' +
              (c ? ICONS[c] + ' ' : '') + labels[c] + (c ? ' (' + d.counts[c] + ')' : ' (' + d.total + ')') + '</span>';
          }).join('');
        $('#cats').querySelectorAll('.chip').forEach(function (ch) {
          ch.onclick = function () { curCat = ch.dataset.c; loadFiles(); };
        });

        if (!d.files.length) {
          $('#fileList').innerHTML = '<p class="muted">فایلی پیدا نشد.</p>';
          return;
        }
        $('#fileList').innerHTML = d.files.map(function (f) {
          return '<div class="frow">' +
            '<span class="ic">' + (ICONS[f.category] || '📎') + '</span>' +
            '<div class="info"><div class="nm">' + esc(f.name) + '</div>' +
            '<div class="sub">' + fmtSize(f.size) + ' · ' + esc(f.uploader) + ' · ' + fmtTime(f.createdAt) +
            (f.source === 'chat' ? ' · از چت' : '') + '</div></div>' +
            '<a href="/api/view/' + f.id + '" target="_blank">👁️</a>' +
            '<a href="/api/download/' + f.id + '">⬇️ دانلود</a>' +
            '<button class="del" data-id="' + f.id + '" data-n="' + esc(f.name) + '">🗑️</button>' +
            '</div>';
        }).join('');
        $('#fileList').querySelectorAll('.del').forEach(function (b) {
          b.onclick = function () {
            if (!confirm('حذف «' + b.dataset.n + '» ؟')) return;
            fetch('/api/files/' + b.dataset.id, { method: 'DELETE' }).then(loadFiles);
          };
        });
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
    $('#hostInfo').textContent = location.origin;
    var h = (location.hash || '#upload').slice(1);
    showTab(['upload', 'chat', 'panel'].indexOf(h) > -1 ? h : 'upload');
    poll();
  });
})();
