import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted IBM Plex Mono (no third-party font CDN): the weights used by the UI.
import '@fontsource/ibm-plex-mono/300.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/400-italic.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './index.css'
import '@xterm/xterm/css/xterm.css'
import App from './App.jsx'
import { purgeLegacyAuthToken } from './services/api'

// Older dashboard versions persisted the admin AUTH_TOKEN in localStorage.
// Authentication is now an HttpOnly session cookie — remove any leftover copy.
purgeLegacyAuthToken()

// Apply saved theme before first paint to avoid flash
try {
  const saved = localStorage.getItem('tv-theme') === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', saved);
} catch {
  document.documentElement.setAttribute('data-theme', 'dark');
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
