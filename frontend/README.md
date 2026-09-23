# TunnelVault dashboard

React (Vite) admin dashboard for the TunnelVault server. The production build in `dist/` is served by the
backend on the API port (behind nginx when the server is installed with `--tls`).

## Development

```bash
npm install            # once
npm run dev            # http://localhost:3000, proxies /api and /ws to http://localhost:4000
npm run lint           # ESLint (must report zero problems)
npm test               # unit tests (node:test) for the API client and URL helpers
npm run build          # production build into dist/
```

## Security model

- Sign-in: `POST /api/auth/login` with the server's `AUTH_TOKEN`; the server answers with an HttpOnly,
  SameSite=Strict session cookie. The token is never stored in the browser (a legacy
  `localStorage` copy from older versions is deleted on startup). All requests use
  `credentials: 'same-origin'`; a 401 sends the user back to the login screen.
- The web SSH terminal (`/ws/ssh`) authenticates with the same cookie, carries terminal data as binary
  WebSocket frames (UTF-8 decoded by xterm.js) and asks the admin to verify SSH host keys (pinning,
  mismatch warning).
- Fonts (IBM Plex Mono) are self-hosted via `@fontsource`; the build never inlines fonts as `data:` URIs so
  the server's CSP (`font-src 'self'`) applies. No third-party requests are made.
