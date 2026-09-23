import { createContext, useContext } from 'react';

/**
 * Auth state shared by AuthGate with the rest of the dashboard.
 *   authRequired — false when the server runs without AUTH_TOKEN (development mode)
 *   logout()     — ends the cookie session; rejects with ApiError on failure
 */
export const AuthContext = createContext({
  authRequired: true,
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}
