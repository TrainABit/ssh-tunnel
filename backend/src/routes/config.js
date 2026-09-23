const { Router } = require('express');

/**
 * GET /api/config (auth) — effective, non-secret server configuration for the
 * dashboard (install commands, settings page):
 * { version, domain, apiPort, proxyPort, tcpPortRange:[min,max], publicUrl, httpTunnelUrlTemplate,
 *   trustProxy, geoipProvider, storedKeysEnabled, sessionRetentionDays, tunnelIdleRetentionDays,
 *   maxTunnelsPerToken, autoUpdate: { enabled, schedule } }
 *
 * @param {() => object} getConfig - returns the current public config
 */
function configRouter(getConfig) {
  const router = Router();
  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getConfig());
  });
  return router;
}

module.exports = configRouter;
