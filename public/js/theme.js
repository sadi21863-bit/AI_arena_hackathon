// Shared dark-mode toggle wiring. The initial data-theme attribute is set
// by a tiny inline script in each page's <head> (before this loads) so
// there's no flash of the wrong theme on first paint — this file only
// wires up the click handler once the DOM is ready.
(function () {
  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("arena-theme", theme); } catch (e) {}
  }

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.querySelector(".arena-theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      apply(current === "dark" ? "light" : "dark");
    });
  });
})();
