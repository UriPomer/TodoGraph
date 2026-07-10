import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

const backgroundIndex = Math.floor(Math.random() * 6) + 1;
document.documentElement.style.setProperty('--bg-url', `url('/bg-${backgroundIndex}.jpg')`);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
