// If the app fails to boot, show the reason instead of a blank page. Kept out
// of index.html so the Content-Security-Policy needs no inline scripts.
//
// A page from before a deploy can ask for that version's bundle after the
// deploy removed it: reopening the app's last tab lets the new service worker
// take over (clearing the old files) just after the old one served the page.
// Reloading then gets the new page and bundle, so a bundle that fails to load
// reloads once (per file, so it can't loop) before the reason is shown.
(function () {
  function show(text) {
    var message = document.getElementById('wt-boot-msg');
    if (message && !message.textContent) message.textContent = text;
  }
  function reloadOnceFor(src) {
    try {
      if (sessionStorage.getItem('wt-reloaded-for') === src) return false;
      sessionStorage.setItem('wt-reloaded-for', src);
    } catch {
      return false; // No storage to remember it in: don't risk reloading forever.
    }
    location.reload();
    return true;
  }
  window.addEventListener(
    'error',
    function (event) {
      var target = event.target;
      if (target && target.tagName === 'SCRIPT') {
        if (/\/assets\//.test(target.src || '') && reloadOnceFor(target.src)) return;
        show('Failed to load ' + (target.src || 'script'));
      } else show(event.message || 'Unknown error');
    },
    true,
  );
  window.addEventListener('unhandledrejection', function (event) {
    show((event.reason && event.reason.message) || String(event.reason));
  });
})();
