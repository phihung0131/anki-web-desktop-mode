// AnkiWeb Desktop Mode - content script
(() => {
  'use strict';

  // ---------- Cài đặt (chrome.storage, dùng chung ankiweb.net và ankiuser.net) ----------
  const S = { theme: 'auto', autoplay: true, repeat: 1, repeatGap: 2, undoDelay: 3, focus: true };
  const store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) || null;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const GAP_MS = 250;     // nghỉ giữa các file âm thanh
  const SETTLE_MS = 120;  // chờ DOM ổn định trước khi phát

  function applySettings() {
    const dark = S.theme === 'dark' || (S.theme === 'auto' && mq.matches);
    document.documentElement.classList.toggle('aw-dark', dark);
    document.documentElement.classList.toggle('aw-focus', !!S.focus);
  }
  function saveSettings() {
    applySettings();
    try { store && store.set({ aw: S }); } catch (e) { /* bỏ qua */ }
  }
  mq.addEventListener('change', applySettings);
  applySettings();
  try {
    store && store.get('aw', (r) => {
      if (r && r.aw) Object.assign(S, r.aw);
      applySettings();
      syncPanel();
    });
    chrome.storage.onChanged.addListener((c) => {
      if (c.aw && c.aw.newValue) { Object.assign(S, c.aw.newValue); applySettings(); syncPanel(); }
    });
  } catch (e) { /* bỏ qua */ }

  // ---------- Tiện ích DOM ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mainEl = () => document.querySelector('main');
  const btnByText = (re) =>
    [...document.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));
  const hasShowAnswer = () => !!btnByText(/^show answer$/i);
  const hasRating = () => !!btnByText(/^(again|hard|good|easy)$/i);
  const getAudios = () => [...document.querySelectorAll('audio')];
  const srcOf = (a) => a.currentSrc || a.src || (a.querySelector('source') || {}).src || '';

  // ---------- Toast ----------
  let toastEl = null;
  let toastTimer = null;
  function toast(msg, onClick) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'aw-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.onclick = onClick || null;
    toastEl.classList.toggle('aw-click', !!onClick);
    toastEl.classList.add('aw-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('aw-show'), 2500);
  }

  // ---------- Phát âm thanh tuần tự (có lặp) ----------
  let runId = 0;
  let blockedList = null; // danh sách bị Chrome chặn autoplay, phát bù ở thao tác đầu tiên

  function setPlaying(a, on) {
    const b = a.previousElementSibling;
    if (b && b.classList && b.classList.contains('aw-play')) b.classList.toggle('aw-playing', on);
  }
  function stopAll() {
    runId++;
    getAudios().forEach((a) => {
      try { a.pause(); a.currentTime = 0; } catch (e) { /* bỏ qua */ }
      setPlaying(a, false);
    });
  }
  const isPlaying = () => !!document.querySelector('.aw-play.aw-playing');

  function waitEnd(a) {
    return new Promise((resolve) => {
      const done = () => {
        a.removeEventListener('ended', done);
        a.removeEventListener('error', done);
        a.removeEventListener('pause', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 60000);
      a.addEventListener('ended', done);
      a.addEventListener('error', done);
      a.addEventListener('pause', done);
    });
  }

  async function playList(list) {
    stopAll();
    const id = runId;
    const total = S.repeat === 0 ? Infinity : Math.max(1, S.repeat);
    for (let rep = 0; rep < total; rep++) {
      for (const a of list) {
        if (id !== runId) return;
        if (!a.isConnected) continue;
        try {
          a.currentTime = 0;
          setPlaying(a, true);
          await a.play();
          await waitEnd(a);
        } catch (e) {
          if (e && e.name === 'NotAllowedError') {
            blockedList = list.slice(list.indexOf(a));
            setPlaying(a, false);
            return;
          }
        }
        setPlaying(a, false);
        if (id !== runId) return;
        await sleep(GAP_MS);
      }
      if (rep < total - 1) {
        if (!list.some((x) => x.isConnected)) return;
        await sleep(Math.max(0, S.repeatGap) * 1000);
      }
    }
  }

  // Âm thanh cần phát lại: ở mặt đáp án chỉ phát âm thanh mặt sau (nếu có)
  let questionSrcs = new Set();
  function replayList() {
    const all = getAudios();
    if (hasRating()) {
      const back = all.filter((a) => !questionSrcs.has(srcOf(a)));
      if (back.length) return back;
    }
    return all;
  }

  // ---------- Thay thanh audio bằng nút tròn ----------
  function enhanceAudios() {
    getAudios().forEach((a) => {
      a.controls = false;
      a.preload = 'auto';
      const prev = a.previousElementSibling;
      if (prev && prev.classList && prev.classList.contains('aw-play')) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'aw-play';
      b.setAttribute('aria-label', 'Phát âm thanh');
      b.title = 'Phát / dừng (M)';
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (b.classList.contains('aw-playing')) stopAll();
        else playList([a]);
      });
      a.parentNode.insertBefore(b, a);
    });
  }

  // ---------- Theo dõi trạng thái thẻ để tự phát ----------
  let prevState = 'none';
  let prevSig = '';
  let played = new Set();
  let pending = null;

  function signature(audios) {
    const m = mainEl();
    return audios.map(srcOf).join('|') + '#' + (m ? m.innerText.slice(0, 200) : '');
  }

  function tick() {
    pending = null;
    buildPanel();
    if (!mainEl()) return;
    enhanceAudios();
    tagButtons();

    const st = hasShowAnswer() ? 'question' : hasRating() ? 'answer' : 'none';
    const audios = getAudios();

    if (st === 'question') {
      const sig = signature(audios);
      if (prevState !== 'question' || sig !== prevSig) {
        played = new Set(audios.map(srcOf));
        questionSrcs = new Set(played);
        prevSig = sig;
        if (S.autoplay && audios.length) setTimeout(() => playList(getAudios()), SETTLE_MS);
      }
    } else if (st === 'answer' && prevState !== 'answer') {
      if (S.autoplay) {
        // Chỉ phát âm thanh mới của mặt sau, bỏ qua âm thanh mặt trước lặp lại do {{FrontSide}}
        const fresh = audios.filter((a) => !played.has(srcOf(a)));
        fresh.forEach((a) => played.add(srcOf(a)));
        if (fresh.length) setTimeout(() => playList(fresh), SETTLE_MS);
      }
    }
    prevState = st;
  }

  function schedule() {
    if (!pending) pending = setTimeout(tick, 80);
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();

  // ---------- Chấm điểm có hoàn tác ----------
  const RATES = ['again', 'hard', 'good', 'easy'];
  const rateBtn = (name) => btnByText(new RegExp('^' + name + '$', 'i'));
  let pendingRate = null; // { btn, timer }

  function tagButtons() {
    RATES.forEach((n, i) => {
      const b = rateBtn(n);
      if (b) { b.dataset.awRate = n; b.dataset.awKey = String(i + 1); }
    });
    const s = btnByText(/^show answer$/i);
    if (s) s.dataset.awKey = 'Space';
  }
  function sendRate(btn) {
    btn.dataset.awBypass = '1';
    btn.click();
    delete btn.dataset.awBypass;
  }
  function flushRate() {
    if (!pendingRate) return;
    const p = pendingRate;
    pendingRate = null;
    clearTimeout(p.timer);
    if (p.btn.isConnected) sendRate(p.btn);
  }
  function undoRate() {
    if (!pendingRate) return false;
    clearTimeout(pendingRate.timer);
    pendingRate = null;
    toast('Đã hoàn tác, chọn lại điểm');
    return true;
  }
  function queueRate(btn, name) {
    if (!S.undoDelay) { sendRate(btn); return; }
    if (pendingRate) clearTimeout(pendingRate.timer);
    pendingRate = { btn, timer: setTimeout(flushRate, S.undoDelay * 1000) };
    toast('Đã chọn ' + name.toUpperCase() + ' · bấm Z để hoàn tác', undoRate);
  }

  // Chuột: nút chấm điểm cũng đi qua cửa sổ hoàn tác
  window.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (!b || b.dataset.awBypass || !b.dataset.awRate || !e.isTrusted) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    queueRate(b, b.dataset.awRate);
  }, true);
  window.addEventListener('pagehide', flushRate);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushRate(); });

  // ---------- Phím tắt ----------
  function retryBlocked() {
    if (!blockedList) return;
    const l = blockedList.filter((a) => a.isConnected);
    blockedList = null;
    if (l.length) playList(l);
  }
  document.addEventListener('pointerdown', retryBlocked, true);

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
    const k = e.key.toLowerCase();
    if ((k === ' ' || k === 'enter') && t && /^(a|button)$/i.test(t.tagName) && !t.dataset.awKey) return;
    if (k !== 'm' && k !== 'r') retryBlocked();
    let handled = false;

    if (k === ' ' || k === 'enter') {
      const s = btnByText(/^show answer$/i);
      if (s) { s.click(); handled = true; }
      else if (hasRating() && k === ' ') handled = true; // chặn cuộn trang
    } else if (k >= '1' && k <= '4') {
      const name = RATES[+k - 1];
      const b = rateBtn(name);
      if (b) { queueRate(b, name); handled = true; }
    } else if (k === 'z' || k === 'backspace') {
      handled = undoRate();
    } else if (k === 'f') {
      S.focus = !S.focus;
      saveSettings();
      syncPanel();
      handled = true;
    } else if ((k === 'm' || k === 'r') && getAudios().length) {
      blockedList = null;
      if (k === 'm' && isPlaying()) stopAll();
      else playList(replayList());
      handled = true;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // ---------- Bảng cài đặt ----------
  let panel = null;
  function syncPanel() {
    if (!panel) return;
    panel.querySelectorAll('[data-k]').forEach((el) => {
      const v = S[el.dataset.k];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    });
  }
  function buildPanel() {
    if (panel || !document.body) return;
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'aw-gear';
    gear.title = 'Cài đặt';
    gear.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/>' +
      '<circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/>' +
      '<circle cx="8" cy="17" r="2" fill="currentColor"/></svg>';
    panel = document.createElement('div');
    panel.className = 'aw-panel';
    panel.hidden = true;
    panel.innerHTML =
      '<div class="aw-title">Cài đặt</div>' +
      '<label>Giao diện<select data-k="theme"><option value="auto">Theo hệ thống</option>' +
      '<option value="light">Sáng</option><option value="dark">Tối</option></select></label>' +
      '<label>Chế độ tập trung (F)<span class="aw-sw"><input type="checkbox" data-k="focus"><i></i></span></label>' +
      '<label>Tự phát âm thanh<span class="aw-sw"><input type="checkbox" data-k="autoplay"><i></i></span></label>' +
      '<label>Lặp âm thanh<select data-k="repeat"><option value="1">1 lần</option><option value="2">2 lần</option>' +
      '<option value="3">3 lần</option><option value="5">5 lần</option><option value="0">Vô hạn</option></select></label>' +
      '<label>Nghỉ giữa các lần<select data-k="repeatGap"><option value="1">1 giây</option><option value="2">2 giây</option>' +
      '<option value="3">3 giây</option><option value="5">5 giây</option></select></label>' +
      '<label>Chờ hoàn tác<select data-k="undoDelay"><option value="0">Tắt</option><option value="2">2 giây</option>' +
      '<option value="3">3 giây</option><option value="5">5 giây</option></select></label>' +
      '<div class="aw-keys"><b>Space</b> đáp án · <b>1-4</b> chấm điểm · <b>Z</b> hoàn tác · ' +
      '<b>M</b> phát/dừng · <b>R</b> nghe lại · <b>F</b> tập trung</div>';
    panel.addEventListener('change', (e) => {
      const el = e.target;
      const k = el.dataset && el.dataset.k;
      if (!k) return;
      S[k] = el.type === 'checkbox' ? el.checked : k === 'theme' ? el.value : +el.value;
      saveSettings();
    });
    gear.addEventListener('click', () => { panel.hidden = !panel.hidden; });
    document.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !gear.contains(e.target)) panel.hidden = true;
    }, true);
    document.body.append(gear, panel);
    syncPanel();
  }
})();
