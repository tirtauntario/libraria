import { navItems } from './lib/extensions';
import { registerRoute } from './lib/router.svelte';
import AboutPage from './routes/AboutPage.svelte';
import BookPage from './routes/BookPage.svelte';
import Home from './routes/Home.svelte';
import Libraries from './routes/Libraries.svelte';
import LibraryPage from './routes/LibraryPage.svelte';
import NotFound from './routes/NotFound.svelte';
import ReaderPage from './routes/ReaderPage.svelte';
import SettingsPage from './routes/SettingsPage.svelte';

registerRoute({ pattern: '/', component: Home, section: 'home' });
registerRoute({ pattern: '/library/:id', component: LibraryPage, section: 'libraries' });
registerRoute({ pattern: '/libraries', component: Libraries, section: 'libraries' });
registerRoute({ pattern: '/book/:id', component: BookPage, section: 'libraries' });
registerRoute({ pattern: '/settings', component: SettingsPage, section: 'settings' });
registerRoute({ pattern: '/about', component: AboutPage, section: 'settings' });
registerRoute({ pattern: '/read/:id', component: ReaderPage, layout: 'bare' });
registerRoute({ pattern: '/*', component: NotFound });

navItems.register({ id: 'home', label: 'Home', href: '#/', icon: 'home', order: 0 });
navItems.register({ id: 'libraries', label: 'Libraries', href: '#/libraries', icon: 'library', order: 10 });
navItems.register({ id: 'settings', label: 'Settings', href: '#/settings', icon: 'settings', order: 100 });
