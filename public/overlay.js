// elkz now playing overlay
// Options go on the end of the URL, e.g. /overlay?layout=tall&hide=0
//   layout=card|tall      wide card (default) or art on top
//   art=left|right        which side the art sits on in the card layout
//   accent=art|brand      colour from the album art (default) or always elkz orange
//   hide=10               hide after this many seconds paused (0 = never hide, show "Paused")
//   bg=solid|none         dark card behind it, or see-through
//   time=1|0              show the time left
//   server=https://...    only needed if this page is hosted somewhere else (e.g. GitHub Pages)
//   demo=1                fake tracks, for lining it up in OBS before Spotify is set up

(function () {
  var q = new URLSearchParams(window.NP_QUERY || location.search);
  var OPT = {
    layout: q.get('layout') === 'tall' ? 'tall' : 'card',
    artSide: q.get('art') === 'right' ? 'right' : 'left',
    accent: q.get('accent') === 'brand' ? 'brand' : 'art',
    hide: q.has('hide') ? Math.max(0, parseFloat(q.get('hide')) || 0) : 10,
    bg: q.get('bg') === 'none' ? 'none' : 'solid',
    time: q.get('time') !== '0',
    server: (q.get('server') || '').replace(/\/+$/, ''),
    demo: q.get('demo') === '1'
  };
  var BRAND = '#E86200';

  var el = document.getElementById('np');
  var $ = function (id) { return document.getElementById(id); };
  var arts = [$('art-a'), $('art-b')], artIdx = 0;
  var titleBox = el.querySelector('.np-title'), titleEl = $('title'), artistEl = $('artist'), labelEl = $('label');
  var timeEl = $('time'), prog = $('prog'), wipe = $('wipe');

  el.classList.add(OPT.layout);
  if (OPT.artSide === 'right') el.classList.add('right');
  if (OPT.bg === 'none') el.classList.add('clear');
  if (!OPT.time) timeEl.style.display = 'none';

  /* ==================== STATE ==================== */
  var shown = null;          // the track currently on the card
  var latest = null;         // the newest update from the server
  var pausedSince = 0, hideTimer = null, busy = false;

  function fmt(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function position() {
    if (!latest || latest.status !== 'track') return 0;
    var p = latest.progressMs + (latest.playing ? Date.now() - latest.at : 0);
    return Math.min(latest.durationMs || p, p);
  }

  /* ---------- progress bar and time, ticking locally between updates ---------- */
  setInterval(function () {
    if (!shown || !latest || latest.status !== 'track' || latest.id !== shown.id) return;
    var d = latest.durationMs || 1, p = position();
    prog.style.transform = 'scaleX(' + Math.min(1, p / d).toFixed(4) + ')';
    timeEl.textContent = '-' + fmt(d - p);
  }, 250);

  /* ---------- show / hide ---------- */
  function show() { clearTimeout(hideTimer); hideTimer = null; el.classList.remove('hidden'); }
  function hideSoon(sec) {
    if (hideTimer || el.classList.contains('hidden')) return;
    hideTimer = setTimeout(function () { hideTimer = null; el.classList.add('hidden'); }, sec * 1000);
  }

  /* ---------- colour from the album art ---------- */
  var cv = document.createElement('canvas'); cv.width = cv.height = 24;
  var cx = cv.getContext('2d', { willReadFrequently: true });
  function artColour(img) {
    try {
      cx.drawImage(img, 0, 0, 24, 24);
      var d = cx.getImageData(0, 0, 24, 24).data, best = null, bestScore = -1;
      // pick the most colourful, reasonably bright pixel group
      var buckets = {};
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], g = d[i + 1], b = d[i + 2];
        var max = Math.max(r, g, b), min = Math.min(r, g, b), sat = max ? (max - min) / max : 0, lum = max / 255;
        if (lum < 0.25) continue;
        var key = (r >> 5) + ',' + (g >> 5) + ',' + (b >> 5);
        var bk = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, n: 0, s: 0 });
        bk.r += r; bk.g += g; bk.b += b; bk.n++; bk.s += sat * Math.min(1, lum * 1.4);
      }
      for (var k in buckets) {
        var B = buckets[k], score = B.s * Math.sqrt(B.n);
        if (score > bestScore) { bestScore = score; best = B; }
      }
      if (!best || best.s / best.n < 0.22) return BRAND;       // greyscale art: stay on brand orange
      var c = [best.r / best.n, best.g / best.n, best.b / best.n];
      // lift dark colours so the bar reads on the dark card
      var m = Math.max(c[0], c[1], c[2]); if (m < 170) { var f = 170 / m; c = c.map(function (v) { return Math.min(255, v * f); }); }
      return 'rgb(' + c.map(Math.round).join(',') + ')';
    } catch (e) { return BRAND; }
  }
  function onColour(rgb) {
    var m = rgb.match(/\d+/g) || [232, 98, 0];
    var L = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
    return L > 0.5 ? '#131518' : '#FFFFFF';
  }

  /* ---------- long titles scroll back and forth ---------- */
  var marqueeTimer = null;
  function marquee() {
    clearTimeout(marqueeTimer);
    titleEl.style.transition = 'none'; titleEl.style.transform = 'none';
    var over = titleEl.scrollWidth - titleBox.clientWidth;
    if (over <= 2) return;
    var ms = Math.max(1500, over * 28), out = true;
    function step() {
      titleEl.style.transition = 'transform ' + ms + 'ms linear';
      titleEl.style.transform = out ? 'translateX(' + (-over) + 'px)' : 'none';
      out = !out;
      marqueeTimer = setTimeout(step, ms + 2600);
    }
    marqueeTimer = setTimeout(step, 3000);
  }

  /* ---------- put a track on the card ---------- */
  function fill(t) {
    titleEl.textContent = t.title;
    artistEl.textContent = t.artists + (t.album && OPT.layout === 'tall' ? '  ·  ' + t.album : '');
    var src = t.art ? (/^(data:|https?:)/.test(t.art) ? t.art : OPT.server + t.art) : '';
    var next = arts[1 - artIdx], prev = arts[artIdx];
    next.onload = function () {
      next.classList.add('on'); prev.classList.remove('on'); artIdx = 1 - artIdx;
      var c = OPT.accent === 'art' ? artColour(next) : BRAND;
      el.style.setProperty('--accent', c);
      el.style.setProperty('--on-accent', onColour(c));
    };
    next.onerror = function () { prev.classList.remove('on'); el.style.setProperty('--accent', BRAND); };
    if (src) { next.crossOrigin = 'anonymous'; next.src = src; } else next.onerror();
    var d = t.durationMs || 1;
    prog.style.transform = 'scaleX(' + Math.min(1, position() / d).toFixed(4) + ')';
    timeEl.textContent = '-' + fmt(d - position());
    marquee();
  }

  // a new track: the accent sweeps across, the card changes underneath, then it sweeps away
  function swap(t) {
    busy = true;
    wipe.style.transition = 'none'; wipe.style.transformOrigin = '0 50%'; wipe.style.transform = 'scaleX(0)';
    void wipe.offsetWidth;
    wipe.style.transition = 'transform 420ms cubic-bezier(0.65, 0, 0.35, 1)';
    wipe.style.transform = 'scaleX(1)';
    setTimeout(function () {
      fill(t);
      wipe.style.transition = 'none'; wipe.style.transformOrigin = '100% 50%';
      void wipe.offsetWidth;
      wipe.style.transition = 'transform 480ms cubic-bezier(0.65, 0, 0.35, 1)';
      wipe.style.transform = 'scaleX(0)';
      setTimeout(function () { wipe.style.transition = 'none'; wipe.style.transform = 'scaleX(0)'; busy = false; render(); }, 520);
    }, 450);
  }

  /* ==================== UPDATES ==================== */
  function render() {
    if (busy) return;
    var s = latest;
    if (!s || s.status !== 'track') {
      // nothing playing, an advert, or Spotify not signed in
      if (OPT.hide === 0 && shown) { el.classList.add('paused'); labelEl.textContent = s && s.status === 'ad' ? 'Advert' : 'Paused'; }
      else hideSoon(OPT.hide === 0 ? 0 : Math.min(OPT.hide, 2));
      return;
    }
    el.classList.toggle('paused', !s.playing);
    labelEl.textContent = s.playing ? (s.type === 'episode' ? 'Now listening' : 'Now playing') : 'Paused';

    if (!shown || shown.id !== s.id) {
      var first = !shown || el.classList.contains('hidden');
      shown = s;
      if (first) { fill(s); if (s.playing || OPT.hide === 0) show(); }
      else swap(s);
    }
    if (s.playing) { pausedSince = 0; show(); }
    else {
      if (!pausedSince) pausedSince = Date.now();
      if (OPT.hide > 0) hideSoon(Math.max(0, OPT.hide - (Date.now() - pausedSince) / 1000));
    }
  }

  function update(s) {
    if (!s) return;
    s.at = Date.now();          // the server sends the position as of sending, so count on from arrival
    latest = s;
    render();
  }

  /* ---------- connection to the server ---------- */
  function connect() {
    if (window.EventSource) {
      var es = new EventSource(OPT.server + '/events');
      es.onmessage = function (e) { try { update(JSON.parse(e.data)); } catch (err) {} };
      // EventSource reconnects by itself if the server restarts
    } else {
      (function poll() {
        fetch(OPT.server + '/api/now-playing').then(function (r) { return r.json(); }).then(update).catch(function () {})
          .then(function () { setTimeout(poll, 3000); });
      })();
    }
  }

  /* ---------- demo: fake tracks so you can line it up in OBS ---------- */
  function demoArt(a, b, c) {
    var k = document.createElement('canvas'); k.width = k.height = 300;
    var g = k.getContext('2d'), gr = g.createLinearGradient(0, 0, 300, 300);
    gr.addColorStop(0, a); gr.addColorStop(1, b); g.fillStyle = gr; g.fillRect(0, 0, 300, 300);
    g.fillStyle = c; g.beginPath(); g.arc(200, 110, 70, 0, 7); g.fill();
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(0, 210, 300, 90);
    return k.toDataURL('image/png');
  }
  function demo() {
    var tracks = [
      { title: 'Northern Lights Over the Ridge', artists: 'Demo Artist', album: 'Example Album', durationMs: 214000, art: demoArt('#1b2a6b', '#0b1030', '#E86200') },
      { title: 'Low Tide', artists: 'Another Example, Feat. Someone', album: 'Placeholder', durationMs: 187000, art: demoArt('#0f5132', '#062016', '#9be15d') },
      { title: 'A Much Longer Song Title That Has To Scroll Across The Card', artists: 'Third Demo Band', album: 'Sample Sessions', durationMs: 241000, art: demoArt('#5b1a6b', '#1d0a24', '#f472b6') }
    ];
    var i = 0, playing = true;
    function push() {
      var t = tracks[i % tracks.length];
      update({ status: 'track', playing: playing, id: 'demo' + (i % tracks.length), type: 'track', title: t.title, artists: t.artists,
        album: t.album, art: t.art, durationMs: t.durationMs, progressMs: 40000 + (i * 17000) % 90000 });
    }
    push();
    setInterval(function () { i++; playing = true; push(); }, 14000);
  }

  if (OPT.demo) demo(); else connect();
})();
