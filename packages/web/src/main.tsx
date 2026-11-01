import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App';
import './style.css';
import './workspace.css';
import './ambient.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><MotionConfig reducedMotion="user"><App /></MotionConfig></StrictMode>,
);
