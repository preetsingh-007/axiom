import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './ui/styles/global.css';
import './ui/components/components.css';
import './ui/desk/desk.css';
import './ui/library/library.css';
import './ui/app/settings.css';
import './ui/ink/ink.css';
import { bootstrap } from './ui/app/bootstrap';
import { ServicesContext } from './ui/app/services';
import { App } from './ui/app/App';

const root = createRoot(document.getElementById('root')!);

bootstrap()
  .then((services) => {
    root.render(
      <StrictMode>
        <ServicesContext.Provider value={services}>
          <App />
        </ServicesContext.Provider>
      </StrictMode>,
    );
  })
  .catch((err) => {
    console.error(err);
    const el = document.getElementById('root')!;
    el.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'boot-error';
    box.innerHTML = '<h2>Axiom could not start</h2><p></p><p>Your notes are safe in this browser’s storage. Try reloading; if you are in a private window, storage may be disabled.</p>';
    box.querySelector('p')!.textContent = String(err?.message ?? err);
    el.appendChild(box);
  });
