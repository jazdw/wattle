// If the app fails to boot, show the reason instead of a blank page. Kept out
// of index.html so the Content-Security-Policy needs no inline scripts.
(function () {
  function show(text) {
    var message = document.getElementById('wt-boot-msg');
    if (message && !message.textContent) message.textContent = text;
  }
  window.addEventListener(
    'error',
    function (event) {
      var target = event.target;
      if (target && target.tagName === 'SCRIPT') show('Failed to load ' + (target.src || 'script'));
      else show(event.message || 'Unknown error');
    },
    true,
  );
  window.addEventListener('unhandledrejection', function (event) {
    show((event.reason && event.reason.message) || String(event.reason));
  });
})();
