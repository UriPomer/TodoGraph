import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// iOS home-screen apps may expose navigator.standalone even when the
// display-mode media query does not match. Ordinary tabs/native shells skip it.
const iosHomeScreen = (navigator as Navigator & { standalone?: boolean }).standalone === true;
document.documentElement.toggleAttribute('data-ios-home-screen', iosHomeScreen);

const backgroundIndex = Math.floor(Math.random() * 6) + 1;
document.documentElement.style.setProperty('--bg-url', `url('/bg-${backgroundIndex}.jpg')`);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
