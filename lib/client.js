/**
 * dsh-restart-progress client half.
 * Zero-dependency in-page restart overlay: a background ping probes the dsh
 * web server every few seconds; when the server disappears (service restart),
 * a full-screen spinner overlay is shown IN THE CURRENT PAGE. Once the server
 * is back the page reloads itself. No new tab, no external page.
 */
window.__ModuleLoader__.load({
  id: "dsh-restart-progress",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const inject = [];
    const STATUS_URL = "/api/restart-progress/status";
    const PING_INTERVAL_MS = 2000;
    const PROBE_INTERVAL_MS = 2000;
    const SUCCESS_STREAK = 3;
    const TIMEOUT_MS = 5 * 60 * 1000;

    let overlayEl = null;
    let statusEl = null;
    let timerEl = null;
    let probeTimerId = null;
    let tick = 0;
    let streak = 0;
    let finished = false;
    let dismissed = false;

    const CSS = [
      ".dsh-rp-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(4,10,24,.88);backdrop-filter:blur(4px)}",
      ".dsh-rp-card{text-align:center;padding:44px 52px;color:#c9d6ee;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}",
      ".dsh-rp-spinner{width:64px;height:64px;margin:0 auto 24px;border-radius:50%;border:5px solid rgba(0,102,255,.18);border-top-color:#06f;animation:dsh-rp-spin .9s linear infinite}",
      "@keyframes dsh-rp-spin{to{transform:rotate(360deg)}}",
      ".dsh-rp-title{font-size:20px;font-weight:600;margin-bottom:8px}",
      ".dsh-rp-status{font-size:13px;color:#8ea3c8;min-height:18px}",
      ".dsh-rp-timer{font-size:12px;color:#5d7299;margin-top:14px;font-variant-numeric:tabular-nums}",
      ".dsh-rp-close{position:absolute;top:20px;right:20px;width:56px;height:56px;border-radius:50%;border:2px solid rgba(201,214,238,.35);background:rgba(255,255,255,.06);color:#c9d6ee;font-size:30px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}",
      ".dsh-rp-close:hover{background:rgba(239,68,68,.25);border-color:#ef4444;color:#fff}",
      ".dsh-rp-hint{position:absolute;bottom:28px;left:0;right:0;text-align:center;font-size:12px;color:#5d7299;font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}",
      ".dsh-rp-err{width:64px;height:64px;margin:0 auto 24px;border-radius:50%;border:5px solid #ef4444;display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:700;color:#ef4444}",
    ].join("");

    function ensureStyles() {
      if (document.getElementById("dsh-restart-progress-style")) return;
      const tag = document.createElement("style");
      tag.id = "dsh-restart-progress-style";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function dismiss() {
      if (overlayEl === null) return;
      console.info("[dsh-restart-progress] dismissed by user (Esc)");
      dismissed = true;
      finished = true;
      if (probeTimerId !== null) {
        clearInterval(probeTimerId);
        probeTimerId = null;
      }
      overlayEl.remove();
      overlayEl = null;
      statusEl = null;
      timerEl = null;
    }

    function show() {
      if (overlayEl || dismissed) return;
      console.info("[dsh-restart-progress] overlay shown (server unreachable)");
      ensureStyles();
      overlayEl = document.createElement("div");
      overlayEl.className = "dsh-rp-overlay";
      overlayEl.innerHTML =
        '<button class="dsh-rp-close" title="退出" aria-label="退出">&#10005;</button>' +
        '<div class="dsh-rp-card">' +
        '<div class="dsh-rp-spinner"></div>' +
        '<div class="dsh-rp-title">DSH 服务重启中</div>' +
        '<div class="dsh-rp-status">检测到服务断开，等待恢复…</div>' +
        '<div class="dsh-rp-timer"></div>' +
        "</div>" +
        '<div class="dsh-rp-hint">按 Esc 可强制退出此界面</div>';
      document.body.appendChild(overlayEl);
      overlayEl.querySelector(".dsh-rp-close").addEventListener("click", dismiss);
      statusEl = overlayEl.querySelector(".dsh-rp-status");
      timerEl = overlayEl.querySelector(".dsh-rp-timer");
      tick = 0;
      streak = 0;
      finished = false;
      probe();
      probeTimerId = setInterval(probe, PROBE_INTERVAL_MS);
    }

    function probe() {
      if (finished) return;
      tick++;
      if (timerEl) timerEl.textContent = "已等待 " + tick * (PROBE_INTERVAL_MS / 1000) + " 秒";
      // Reload only when the server is online AND the pending flag is gone:
      // reloading while the flag still exists would re-trigger the overlay
      // and loop forever (the exact bug this guard fixes).
      fetch(STATUS_URL, { cache: "no-store" })
        .then((res) => res.json().then((data) => data, () => null))
        .then((data) => {
          if (data && data.pending === false) {
            streak++;
            if (statusEl) statusEl.textContent = "重启完成，即将刷新页面（" + streak + "/" + SUCCESS_STREAK + "）…";
            if (streak >= SUCCESS_STREAK) finish(true);
          } else if (data && data.pending === true) {
            streak = 0;
            if (statusEl) statusEl.textContent = "服务已在线，等待重启任务收尾…";
          } else {
            streak = 0;
            if (statusEl) statusEl.textContent = "等待服务恢复…";
          }
          if (tick * PROBE_INTERVAL_MS >= TIMEOUT_MS) finish(false);
        })
        .catch(() => {
          streak = 0;
          if (statusEl) statusEl.textContent = "等待服务恢复…";
          if (tick * PROBE_INTERVAL_MS >= TIMEOUT_MS) finish(false);
        });
    }

    function finish(ok) {
      finished = true;
      if (probeTimerId !== null) {
        clearInterval(probeTimerId);
        probeTimerId = null;
      }
      if (ok) {
        console.info("[dsh-restart-progress] server back, reloading page");
        location.reload();
        return;
      }
      if (overlayEl) {
        overlayEl.innerHTML =
          '<button class="dsh-rp-close" title="退出" aria-label="退出">&#10005;</button>' +
          '<div class="dsh-rp-card">' +
          '<div class="dsh-rp-err">!</div>' +
          '<div class="dsh-rp-title">重启超时</div>' +
          '<div class="dsh-rp-status">5 分钟内服务未恢复，请检查 C:\\Users\\mengf\\.dsh\\logs\\dsh-web-restart.log</div>' +
          "</div>" +
          '<div class="dsh-rp-hint">按 Esc 可强制退出此界面</div>';
        overlayEl.querySelector(".dsh-rp-close").addEventListener("click", dismiss);
      }
    }

    /** Client plugin body: status poll + ping loop + event fallback + Esc bailout. */
    function apply(ctx) {
      console.info("[dsh-restart-progress] armed (poll every " + PING_INTERVAL_MS / 1000 + "s)");
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") dismiss();
      });
      let failures = 0;
      let lastPending = false;
      const tick = () => {
        if (overlayEl) return;
        // Any HTTP response (even 404) means the server is alive; only a
        // network failure counts as offline. A pending flag means a restart
        // is about to happen: show the overlay immediately. A fresh
        // false->true pending edge starts a NEW restart round, so a previous
        // Esc/close dismissal does not mute future restarts.
        fetch(STATUS_URL, { cache: "no-store" })
          .then((res) => {
            failures = 0;
            res.json().then((data) => {
              const pending = !!(data && data.pending === true);
              if (pending && !lastPending) {
                dismissed = false;
              }
              lastPending = pending;
              if (pending && !dismissed) {
                console.info("[dsh-restart-progress] pending flag seen, showing overlay early");
                show();
              }
            }).catch(() => {});
          })
          .catch(() => {
            failures++;
            if (failures >= 2 && !dismissed) show();
          });
      };
      tick();
      setInterval(tick, PING_INTERVAL_MS);
      try {
        ctx.on("connection/reset", show);
      } catch (error) {
        console.warn("[dsh-restart-progress] connection/reset hook unavailable:", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
