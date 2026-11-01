// Import order matters: stubs first, real implementations after, so a real
// driver module replaces its stub when it registers the same kind.
import './stubs';
import './local';
import './register';

export * from './registry';
export * from './types';
export { LocalDriver, localStoreName, safeFilename, LOCAL_PREFIX } from './local';
