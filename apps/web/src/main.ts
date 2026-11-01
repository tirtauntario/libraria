import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import './routes';
import './features';

const target = document.getElementById('app')!;
export default mount(App, { target });
