/**
 * Side-effect module, imported first in main.ts: take an OAuth response out
 * of the URL before the hash router reads `location.hash`.
 */
import { captureOAuthRedirect } from './oauth';

if (typeof window !== 'undefined') {
  try {
    captureOAuthRedirect();
  } catch {
    // never block startup
  }
}
