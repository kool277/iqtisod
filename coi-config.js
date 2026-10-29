// Runs before any other script. Keep it tiny and dependency-free.
;(function () {
  var framed = true
  try {
    framed = window.top !== window.self
  } catch (error) {
    framed = true
  }
  window.__moliyaFramed = framed

  // Under the CSP's require-trusted-types-for 'script', only the isolation service worker and the
  // built Argon2 key-derivation worker (same origin, under ./assets/) may be loaded from a string URL.
  // Everything else (HTML, inline script, other URLs) is refused.
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    var worker = new URL('./coi-serviceworker.js', document.baseURI).href
    var assets = new URL('./assets/', document.baseURI)
    var argon2 = /^argon2\.worker-[A-Za-z0-9_-]{6,}\.js$/
    window.trustedTypes.createPolicy('default', {
      createScriptURL: function (value) {
        var url = new URL(value, document.baseURI)
        if (url.origin + url.pathname === worker) return url.href
        var inAssets = url.origin === assets.origin && url.search === '' && url.hash === '' && url.pathname.indexOf(assets.pathname) === 0
        return inAssets && argon2.test(url.pathname.slice(assets.pathname.length)) ? url.href : null
      },
    })
  }

  // coi-serviceworker reloads as soon as a new worker starts installing, but a page loaded before the worker
  // is active is not controlled by it: on a first visit that reload kept the page without isolation until the
  // next one. `ready` resolves once a worker is active, which is at once when one already is.
  function reloadWhenActive() {
    if (!navigator.serviceWorker) return window.location.reload()
    navigator.serviceWorker.ready.then(function () {
      window.location.reload()
    })
  }

  window.coi = framed
    ? {
        quiet: true,
        doReload: reloadWhenActive,
        shouldRegister: function () {
          return false
        },
      }
    : { quiet: true, doReload: reloadWhenActive }
})()
