// Runs before any other script. Keep it tiny and dependency-free.
;(function () {
  var framed = true
  try {
    framed = window.top !== window.self
  } catch (error) {
    framed = true
  }
  window.__moliyaFramed = framed

  // Under the CSP's require-trusted-types-for 'script', only the isolation service worker may be
  // loaded from a string URL. Everything else (HTML, inline script, other URLs) is refused.
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    var worker = new URL('/coi-serviceworker.js', document.baseURI).href
    window.trustedTypes.createPolicy('default', {
      createScriptURL: function (value) {
        var url = new URL(value, document.baseURI)
        return url.origin + url.pathname === worker ? url.href : null
      },
    })
  }

  window.coi = framed
    ? {
        quiet: true,
        shouldRegister: function () {
          return false
        },
      }
    : { quiet: true }
})()
