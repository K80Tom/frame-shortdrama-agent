import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App';
import AuthBoundary from './AuthBoundary';
import { BackdropProvider } from './ambient';
import './style.css';
import './workspace.css';
import './ios-theme.css';
import './brand-flow.css';
import './experience.css';
import './ambient.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><MotionConfig reducedMotion="user"><BackdropProvider><AuthBoundary><App /></AuthBoundary></BackdropProvider></MotionConfig></StrictMode>,
);
