import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Apply saved theme before first paint to avoid flash
try {
  const saved = localStorage.getItem('tv-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
} catch {}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
