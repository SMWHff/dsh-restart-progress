/**
 * dsh-restart-progress host half.
 * Registers one HTTP route: GET /api/restart-progress/status — the browser
 * half polls it to learn that a restart is about to start (the restart script
 * writes a pending flag file BEFORE the service goes down), so the overlay can
 * be shown immediately instead of waiting for the connection to drop.
 */
import { existsSync } from 'node:fs'

const FLAG_FILE = 'C:/Users/mengf/.dsh/logs/restart-pending.flag'

/** Host plugin body: register the status route on the webServer service. */
function apply(ctx) {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => {
      const route = {
        kind: 'exact',
        path: '/api/restart-progress/status',
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }))
            return
          }
          let pending = false
          try {
            pending = existsSync(FLAG_FILE)
          } catch {
            pending = false
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, pending }))
        },
      }
      const disposers = [httpCtx.webServer.register(route)]
      return () => {
        for (const dispose of disposers) {
          if (typeof dispose === 'function') dispose()
        }
      }
    }, 'dsh-restart-progress: status route')
  })
}

export { apply };
