import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App';
import AuthBoundary from './AuthBoundary';
import './style.css';
import './workspace.css';
import './ambient.css';
import './ios-theme.css';
import './brand-flow.css';
import './experience.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><MotionConfig reducedMotion="user"><AuthBoundary><App /></AuthBoundary></MotionConfig></StrictMode>,
);
