import type { BuildInfo } from '@libraria/core';
import pkg from '../package.json' with { type: 'json' };

/** Set by tsup at build time (scripts/build-info.mjs); absent under tsx and in tests. */
declare const __SERVER_BUILD__: BuildInfo | undefined;

export const SERVER_BUILD: BuildInfo | null = typeof __SERVER_BUILD__ === 'undefined' ? null : __SERVER_BUILD__;

/** Semantic version, with build metadata (+commit) unless this is a release build. */
export const SERVER_VERSION: string = SERVER_BUILD?.full ?? pkg.version;
