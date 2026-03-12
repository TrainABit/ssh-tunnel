import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AuthGate from './components/AuthGate';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Tunnels from './pages/Tunnels';
import Connections from './pages/Connections';
import Settings from './pages/Settings';
import Tokens from './pages/Tokens';
import Sessions from './pages/Sessions';
import SetupGuide from './pages/SetupGuide';

export default function App() {
  return (
    <AuthGate>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/tunnels" element={<Tunnels />} />
            <Route path="/connections" element={<Connections />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/tokens" element={<Tokens />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/setup" element={<SetupGuide />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthGate>
  );
}
