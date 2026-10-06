import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { initializeWallpaper } from './platform/wallpaper';

// iOS home-screen apps may expose navigator.standalone even when the
// display-mode media query does not match. Ordinary tabs/native shells skip it.
const iosHomeScreen = (navigator as Navigator & { standalone?: boolean }).standalone === true;
document.documentElement.toggleAttribute('data-ios-home-screen', iosHomeScreen);

const disposeWallpaper = initializeWallpaper();
if (import.meta.hot) import.meta.hot.dispose(disposeWallpaper);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
