/**
 * Extension points for features built on top of the core client (Libraria
 * server integration, sync, more sources). Register from a module imported
 * in `src/features.ts`; nothing in the core app needs to change.
 *
 * - Routes: `registerRoute` in `router.svelte.ts`.
 * - Source kinds: `registerSourceKind` in `sources/registry.ts`.
 * - UI slots: the registries below.
 */
import type { Component } from 'svelte';
import type { BookRecord } from './db/schema';
import type { IconName } from './ui/icons';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  /** Lower comes first. Core items use 0..100. */
  order: number;
}

export interface SettingsSection {
  id: string;
  title: string;
  component: Component;
  order: number;
}

export interface BookPanel {
  id: string;
  /** Rendered on the book detail page, e.g. "Submit to server". */
  component: Component<{ book: BookRecord }>;
  order: number;
}

export interface HomeSection {
  id: string;
  component: Component;
  order: number;
}

function registry<T extends { id: string; order: number }>() {
  const items: T[] = [];
  return {
    register(item: T) {
      const i = items.findIndex((x) => x.id === item.id);
      if (i >= 0) items[i] = item;
      else items.push(item);
      items.sort((a, b) => a.order - b.order);
    },
    list(): readonly T[] {
      return items;
    },
  };
}

export const navItems = registry<NavItem>();
export const settingsSections = registry<SettingsSection>();
export const bookPanels = registry<BookPanel>();
export const homeSections = registry<HomeSection>();

export type StartupHook = () => void | Promise<void>;
const startupHooks: StartupHook[] = [];

/** Run after services and settings are ready (e.g. start the sync engine). */
export function onStartup(hook: StartupHook): void {
  startupHooks.push(hook);
}

export async function runStartupHooks(): Promise<void> {
  for (const hook of startupHooks) {
    try {
      await hook();
    } catch (err) {
      console.error('Startup hook failed', err);
    }
  }
}
