import { useEffect, useState } from 'react';
import { getConfig } from '../services/api';

/**
 * Server configuration from GET /api/config (fetched once per page load and cached).
 * @returns {{ config: object|null, error: Error|null, loading: boolean }}
 */
export default function useServerConfig() {
  const [state, setState] = useState({ config: null, error: null, loading: true });
  useEffect(() => {
    let active = true;
    getConfig().then(
      (config) => { if (active) setState({ config: config || null, error: null, loading: false }); },
      (error) => { if (active) setState({ config: null, error, loading: false }); },
    );
    return () => { active = false; };
  }, []);
  return state;
}
