const { Router } = require('express');

/**
 * Dashboard session endpoints (mounted at /api/auth, no auth required):
 *   POST /login   {token} -> 200 {authenticated:true} + session cookie | 401 | 429
 *   POST /logout          -> 200 {authenticated:false} (cookie cleared)
 *   GET  /session         -> {authenticated: bool, authRequired: bool}
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
