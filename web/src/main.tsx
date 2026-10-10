import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthProvider } from './hooks/useAuth';
import { ConfirmProvider } from './components/ui';
import './styles/tokens.css';
import './styles/app.css';

// Linear's documented CDN font substitutes (Inter + JetBrains Mono). If the
// network is unavailable the CSS stacks fall back to system-ui / ui-monospace.
const fonts = document.createElement('link');
fonts.rel = 'stylesheet';
fonts.href =
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap';
document.head.appendChild(fonts);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ConfirmProvider>
          {/* Outer boundary: a crash in the shell itself still says something instead of blanking
              the page. The inner one in AppShell keeps the nav alive for a broken view. */}
          <ErrorBoundary title="The panel stopped responding">
            <App />
          </ErrorBoundary>
        </ConfirmProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
