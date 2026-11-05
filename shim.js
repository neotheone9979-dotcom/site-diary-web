/* Site Diary for Android: connects the app to Firebase in place of Claude's shared storage.
   It provides the same window.claude.use('db' | 'user' | 'downloads') calls the app already uses,
   and shows the sign-in screen before the app reaches its data. */
(function () {
  var cfg = window.FIREBASE_CONFIG;
  var ready = !!(cfg && cfg.apiKey && cfg.projectId && window.firebase);
  var app, auth, fs, me = null, gate = null;

  function mapErr(e) {
    var c = (e && e.code) || '';
    var code = c === 'permission-denied' || c === 'unauthenticated' ? 'invalid_argument'
      : c === 'resource-exhausted' ? 'resource_exhausted'
      : 'unavailable';
    return { code: code, message: (e && e.message) || 'Firebase error' };
  }

  /* Writes are applied on the phone at once and sent when the network allows.
     Resolve after the server confirms, or after 1.5 s so forms do not hang offline;
     a later refusal is reported through the app's own error message. */
  function write(p) {
    return new Promise(function (res, rej) {
      var done = false;
      p.then(function () { if (!done) { done = true; res(); } }, function (e) {
        var m = mapErr(e);
        if (!done) { done = true; rej(m); } else if (window.__sdFail) window.__sdFail(m);
      });
      setTimeout(function () { if (!done) { done = true; res(); } }, 1500);
    });
  }
  function wrapQuery(q) {
    return {
      where: function (f, o, v) { return wrapQuery(q.where(f, o, v)); },
      orderBy: function (f, d) { return wrapQuery(q.orderBy(f, d)); },
      limit: function (n) { return wrapQuery(q.limit(n)); },
      get: function () { return q.get().catch(function (e) { throw mapErr(e); }); },
      onSnapshot: function (next, err) {
        return q.onSnapshot({ includeMetadataChanges: true }, next, function (e) { if (err) err(mapErr(e)); });
      }
    };
  }
  function wrapDoc(r) {
    return {
      id: r.id, path: r.path,
      get: function () { return r.get(); },
      set: function (d) { return write(r.set(d)); },
      update: function (d) { return write(r.update(d)); },
      delete: function () { return write(r.delete()); },
      onSnapshot: function (next, err) {
        return r.onSnapshot({ includeMetadataChanges: true }, next, function (e) { if (err) err(mapErr(e)); });
      },
      collection: function (p) { return wrapCol(r.collection(p)); }
    };
  }
  function wrapCol(c) {
    var w = wrapQuery(c);
    w.path = c.path;
    w.doc = function (id) { return wrapDoc(id ? c.doc(id) : c.doc()); };
    w.add = function (d) { var r = c.doc(); return write(r.set(d)).then(function () { return wrapDoc(r); }); };
    return w;
  }
  var DB = {
    collection: function (p) { return wrapCol(fs.collection(p)); },
    doc: function (p) { return wrapDoc(fs.doc(p)); }
  };

  var names = {};
  var USER = {
    id: function () { return Promise.resolve(me ? me.uid : null); },
    me: function () { return Promise.resolve({ id: me ? me.uid : null, name: me ? (me.displayName || '') : '', email: me ? me.email : null, isOwner: false, canEdit: true }); },
    profiles: function (ids) {
      ids = [].concat(ids);
      return Promise.all(ids.map(function (id) {
        if (names[id] != null) return Promise.resolve();
        return fs.collection('people').doc(id).get().then(function (d) {
          var x = d.exists ? d.data() : null;
          names[id] = x ? (x.name || x.email || '') : '';
        }, function () { names[id] = ''; });
      })).then(function () {
        var out = {};
        ids.forEach(function (id) { out[id] = { id: id, name: names[id] || '', isMe: !!(me && me.uid === id) }; });
        return out;
      });
    }
  };
  /* In a desktop browser, files go to the browser's normal Downloads folder. */
  var WEB_DOWNLOADS = {
    save: function (o) {
      try {
        var d = o.data;
        var type = /\.csv$/i.test(o.filename) ? 'text/csv;charset=utf-8' : /\.json$/i.test(o.filename) ? 'application/json' : /\.xlsx$/i.test(o.filename) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/octet-stream';
        var blob = d instanceof Blob ? d : new Blob([d], { type: type });
        var u = URL.createObjectURL(blob), a = document.createElement('a');
        a.href = u; a.download = o.filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 4000);
        return Promise.resolve('your Downloads folder');
      } catch (e) {
        return Promise.reject({ code: 'unavailable', message: 'The file could not be saved.' });
      }
    }
  };
  var DOWNLOADS = {
    save: function (o) {
      if (!window.AndroidBridge) return WEB_DOWNLOADS.save(o);
      var d = o.data, p;
      if (typeof d === 'string') p = Promise.resolve(String(window.AndroidBridge.saveFile(o.filename, d)));
      else p = new Promise(function (res, rej) {
        var blob = d instanceof Blob ? d : new Blob([d]);
        var fr = new FileReader();
        fr.onload = function () {
          var u = String(fr.result);
          res(String(window.AndroidBridge.saveBase64(o.filename, u.slice(u.indexOf(',') + 1), blob.type || 'application/octet-stream')));
        };
        fr.onerror = function () { rej({ code: 'unavailable', message: 'The file could not be prepared.' }); };
        fr.readAsDataURL(blob);
      });
      return p.then(function (r) {
        if (r.indexOf('ok:') === 0) return r.slice(3);
        throw { code: 'unavailable', message: r.slice(6) };
      });
    }
  };

  window.claude = {
    use: function (name) {
      if (name === 'db') return signedIn().then(function () { return DB; });
      if (name === 'user') return signedIn().then(function () { return USER; });
      if (name === 'downloads') return Promise.resolve(DOWNLOADS);
      return Promise.resolve(null);
    }
  };

  /* ---------- sign-in screen ---------- */
  var box;
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function css() {
    if (document.getElementById('authCss')) return;
    var s = document.createElement('style'); s.id = 'authCss';
    s.textContent = '.auth{position:fixed;inset:0;z-index:100;background:var(--bg);overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:max(32px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) 32px max(16px,env(safe-area-inset-left,0px))}' +
      '.auth-card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 18px;display:flex;flex-direction:column;gap:14px}' +
      '.auth-logo{background:#fff;border-radius:10px;padding:8px;align-self:flex-start}.auth-logo img{height:40px;width:auto;display:block}' +
      '.auth form{display:flex;flex-direction:column;gap:12px}.auth .err{color:var(--bad);font-size:14px;min-height:1em}.auth .ok{color:var(--good);font-size:14px}' +
      '.auth .links{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.auth .lk{border:0;background:none;color:var(--navy);font:600 14px var(--body);padding:6px 0;cursor:pointer}';
    document.head.appendChild(s);
  }
  function logoSrc() { var l = document.getElementById('logo'); return l && l.src ? l.src : ''; }
  function show(mode, msg) {
    css();
    if (!box) { box = el('<div class="auth" role="dialog" aria-modal="true" aria-labelledby="aT"></div>'); document.body.appendChild(box); }
    box.hidden = false;
    var head = '<div class="auth-logo"><img alt="Act Masters" src="' + logoSrc() + '"></div>';
    var email = auth.currentUser ? auth.currentUser.email : '';
    var h;
    if (mode === 'nocfg') {
      h = head + '<h1 id="aT">Setup needed</h1><p class="muted" style="margin:0">This copy of the app was built without Firebase settings. Ask the office for the current version.</p>';
    } else if (mode === 'verify') {
      h = head + '<h1 id="aT">Check your email</h1><p class="muted" style="margin:0">We sent a link to <b>' + esc(email) + '</b>. Open it to confirm your address, then come back and tap Continue.</p>' +
        '<div class="err" id="aE">' + esc(msg || '') + '</div><button class="btn pri" type="button" id="aV">Continue</button>' +
        '<div class="links"><button class="lk" type="button" id="aR">Send the link again</button><button class="lk" type="button" id="aO">Use another account</button></div>';
    } else if (mode === 'pending') {
      h = head + '<h1 id="aT">Waiting for access</h1><p class="muted" style="margin:0">You are signed in as <b>' + esc(email) + '</b>, but this account has not been given access yet. Ask the office to add your email to the team list, then tap Try again.</p>' +
        '<div class="err" id="aE">' + esc(msg || '') + '</div><button class="btn pri" type="button" id="aV">Try again</button>' +
        '<div class="links"><button class="lk" type="button" id="aO">Use another account</button></div>';
    } else {
      var up = mode === 'signup', reset = mode === 'reset';
      h = head + '<h1 id="aT">' + (up ? 'Create your account' : reset ? 'Reset your password' : 'Sign in to Site Diary') + '</h1>' +
        '<p class="muted" style="margin:0">' + (up ? 'Use your work email. The office must add you to the team before you can see projects.' : reset ? 'We will email you a link to set a new password.' : 'Attendance, plans, daily reports and stores for every Act Masters site.') + '</p>' +
        '<form id="aF" novalidate>' +
        (up ? '<label class="f"><span>Your name</span><input id="aN" autocomplete="name" required></label>' : '') +
        '<label class="f"><span>Email</span><input id="aM" type="email" autocomplete="email" inputmode="email" required value="' + esc(email) + '"></label>' +
        (reset ? '' : '<label class="f"><span>Password</span><input id="aP" type="password" autocomplete="' + (up ? 'new-password' : 'current-password') + '" required minlength="6"></label>') +
        '<div class="' + (msg && msg.ok ? 'ok' : 'err') + '" id="aE">' + esc(msg && msg.text ? msg.text : msg || '') + '</div>' +
        '<button class="btn pri" type="submit" id="aS">' + (up ? 'Create account' : reset ? 'Send reset link' : 'Sign in') + '</button></form>' +
        '<div class="links">' + (mode === 'signin' ? '<button class="lk" type="button" data-m="signup">New here? Create an account</button><button class="lk" type="button" data-m="reset">Forgot password?</button>' : '<button class="lk" type="button" data-m="signin">Back to sign in</button>') + '</div>';
    }
    box.innerHTML = '<div class="auth-card">' + h + '</div>';
    bind(mode);
  }
  function hide() { if (box) box.hidden = true; }
  function say(m) { var e = document.getElementById('aE'); if (e) { e.className = 'err'; e.textContent = m; } }
  function busy(on) { var b = document.getElementById('aS') || document.getElementById('aV'); if (b) b.disabled = on; }
  function authMsg(e) {
    var c = (e && e.code) || '';
    if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return 'The email or password is wrong.';
    if (/email-already-in-use/.test(c)) return 'An account with this email already exists. Sign in instead.';
    if (/weak-password/.test(c)) return 'Use a password of at least 6 characters.';
    if (/invalid-email/.test(c)) return 'Enter a valid email address.';
    if (/network-request-failed/.test(c)) return 'No internet connection. Connect and try again.';
    if (/too-many-requests/.test(c)) return 'Too many attempts. Wait a few minutes and try again.';
    if (/operation-not-allowed/.test(c)) return 'Email sign-in is turned off in Firebase. Ask the office to turn it on.';
    return 'That did not work. Check your connection and try again.';
  }
  function bind(mode) {
    Array.prototype.forEach.call(box.querySelectorAll('[data-m]'), function (b) { b.onclick = function () { show(b.getAttribute('data-m')); }; });
    var out = document.getElementById('aO');
    if (out) out.onclick = function () { auth.signOut().then(function () { show('signin'); }); };
    var f = document.getElementById('aF');
    if (f) f.onsubmit = function (e) {
      e.preventDefault();
      var em = (document.getElementById('aM').value || '').trim(), pw = document.getElementById('aP') ? document.getElementById('aP').value : '';
      if (!em) { say('Enter your email.'); return; }
      if (mode !== 'reset' && pw.length < 6) { say('Enter your password (at least 6 characters).'); return; }
      busy(true);
      var p;
      if (mode === 'signup') {
        var nm = (document.getElementById('aN').value || '').trim();
        if (!nm) { busy(false); say('Enter your name.'); return; }
        p = auth.createUserWithEmailAndPassword(em, pw).then(function (c) {
          return c.user.updateProfile({ displayName: nm }).then(function () { return c.user.sendEmailVerification(); });
        });
      } else if (mode === 'reset') {
        p = auth.sendPasswordResetEmail(em).then(function () { show('signin', { ok: true, text: 'Reset link sent to ' + em + '. Check your email.' }); });
      } else {
        p = auth.signInWithEmailAndPassword(em, pw);
      }
      p.catch(function (err) { busy(false); say(authMsg(err)); });
    };
    var v = document.getElementById('aV');
    if (v) v.onclick = function () {
      busy(true);
      var u = auth.currentUser;
      u.reload().then(function () { return auth.currentUser.getIdToken(true); }).then(function () { check(auth.currentUser); }, function (err) { busy(false); say(authMsg(err)); });
    };
    var r = document.getElementById('aR');
    if (r) r.onclick = function () { auth.currentUser.sendEmailVerification().then(function () { say('Link sent again.'); }, function (err) { say(authMsg(err)); }); };
    var first = box.querySelector('input:not([value]),input[value=""]');
    if (first) setTimeout(function () { first.focus(); }, 50);
  }

  var resolveGate;
  function signedIn() {
    if (!gate) gate = new Promise(function (res) { resolveGate = res; start(); });
    return gate;
  }
  function check(u) {
    if (!u.emailVerified) { show('verify'); return; }
    fs.collection('projects').limit(1).get().then(function () { ok(u); }, function (e) {
      if (e && e.code === 'permission-denied') show('pending');
      else ok(u); /* offline: work from what is saved on the phone */
    });
  }
  var opened = false;
  function ok(u) {
    me = u; hide();
    fs.collection('people').doc(u.uid).set({ name: u.displayName || (u.email || '').split('@')[0], email: u.email || '' }, { merge: true }).catch(function () {});
    window.SD_NATIVE = { email: u.email, name: u.displayName || '', signOut: function () { auth.signOut().then(function () { location.reload(); }); } };
    if (!opened) { opened = true; resolveGate(); }
  }
  function start() {
    var go = function () {
      if (!ready) { auth = { currentUser: null }; show('nocfg'); return; }
      auth.onAuthStateChanged(function (u) {
        if (!u) { if (opened) location.reload(); else show('signin'); return; }
        if (!opened) check(u);
      });
    };
    if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
  }

  if (ready) {
    app = firebase.initializeApp(cfg);
    auth = firebase.auth();
    fs = firebase.firestore();
    /* On a desktop several tabs may be open at once, so they share the saved copy. */
    fs.enablePersistence({ synchronizeTabs: !window.AndroidBridge }).catch(function () {});
  }
})();
