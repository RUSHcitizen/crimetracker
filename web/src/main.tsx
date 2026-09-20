import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';

import './styles/tokens.css';
import './styles/base.css';
import './styles/hud.css';
import './styles/map.css';
import './styles/panels.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
