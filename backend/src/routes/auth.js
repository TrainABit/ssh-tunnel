const { Router } = require('express');

/**
 * Dashboard session endpoints (mounted at /api/auth, no auth required):
 *   POST /login   {token} -> 200 {authenticated:true, authRequired:true, sessionKey} + session cookie | 401 | 429
 *   POST /logout          -> 200 {authenticated:false} (cookie cleared; the session is deleted
 *                            when the request carries the cookie and X-TV-Session-Key)
 *   GET  /session         -> {authenticated: bool, authRequired: bool}; authenticated needs the
 *                            cookie AND X-TV-Session-Key (or a valid Bearer; Bearer failures
 *                            are rate limited like on /api)
 *
 * sessionKey must accompany every cookie-authenticated request: header
 * `X-TV-Session-Key: <sessionKey>`, and for /ws/ssh the subprotocols
 * ['tunnelvault.v1', 'tv-key.<sessionKey>'] (the server selects 'tunnelvault.v1').
 *
 * @param {ReturnType<import('../auth').createAuth>} auth
 */
function authRouter(auth) {
  const router = Router();
  router.post('/login', auth.login);
  router.post('/logout', auth.logout);
  router.get('/session', auth.sessionStatus);
  return router;
}

module.exports = authRouter;
