// First: take an OAuth response out of the URL before the hash router reads it.
import './lib/sources/oauth-capture';
import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import './routes';
import './features';

const target = document.getElementById('app')!;
export default mount(App, { target });
