import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { startRouter } from './router.js';

registerSW({ immediate: true });          // Service Worker: instalación y modo offline
startRouter(document.getElementById('app'));
