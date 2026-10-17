import React, { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router';
import { App } from './App.tsx';
import { BoardPage } from './pages/Board.tsx';
import { CrashBoundary } from './components/CrashScreen.tsx';
import { guardResume } from './resume.ts';
import { lazyPage } from './lazyPage.ts';
import './styles.css';

// Every page but the board loads when first opened: one bundle held them all (1 MB).
const ItemPage = lazyPage(() => import('./pages/Item.tsx').then((m) => m.ItemPage));
const SessionsPage = lazyPage(() => import('./pages/Sessions.tsx').then((m) => m.SessionsPage));
const SwitchProviderPage = lazyPage(() => import('./pages/SwitchProvider.tsx').then((m) => m.SwitchProviderPage));
const SettingsPage = lazyPage(() => import('./pages/Settings.tsx').then((m) => m.SettingsPage));
const ConsolePage = lazyPage(() => import('./pages/Console.tsx').then((m) => m.ConsolePage));
const PromptsPage = lazyPage(() => import('./pages/Prompts.tsx').then((m) => m.PromptsPage));
const ReleasesPage = lazyPage(() => import('./pages/Releases.tsx').then((m) => m.ReleasesPage));
const SchedulesPage = lazyPage(() => import('./pages/Schedules.tsx').then((m) => m.SchedulesPage));
const QuestionPage = lazyPage(() => import('./pages/Question.tsx').then((m) => m.QuestionPage));
const ProjectsPage = lazyPage(() => import('./pages/Projects.tsx').then((m) => m.ProjectsPage));
const UsagePage = lazyPage(() => import('./pages/Usage.tsx').then((m) => m.UsagePage));

guardResume({ win: window, doc: document, storage: { getItem: (k) => sessionStorage.getItem(k), setItem: (k, v) => sessionStorage.setItem(k, v) }, reload: () => location.reload(), now: () => Date.now(), later: (f, ms) => { setTimeout(f, ms); } });

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CrashBoundary>
    <BrowserRouter>
      <Suspense fallback={<p className="muted">Loading…</p>}>
      <Routes>
        <Route element={<App />}>
          <Route index element={<BoardPage lane="board" />} />
          <Route path="icebox" element={<BoardPage lane="icebox" />} />
          <Route path="done" element={<BoardPage lane="done" />} />
          <Route path="items/:id" element={<ItemPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="prompts" element={<PromptsPage />} />
          <Route path="prompts/:name" element={<PromptsPage />} />
          <Route path="releases" element={<ReleasesPage />} />
          <Route path="releases/:version" element={<ReleasesPage />} />
          <Route path="schedules" element={<SchedulesPage />} />
          <Route path="schedules/:name" element={<SchedulesPage />} />
          <Route path="console" element={<ConsolePage />} />
          <Route path="questions/:id" element={<QuestionPage />} />
          <Route path="switch-provider" element={<SwitchProviderPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="usage" element={<UsagePage />} />
        </Route>
      </Routes>
      </Suspense>
    </BrowserRouter>
    </CrashBoundary>
  </React.StrictMode>,
);
