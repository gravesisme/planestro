import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router';
import { App } from './App.tsx';
import { BoardPage } from './pages/Board.tsx';
import { ItemPage } from './pages/Item.tsx';
import { SessionsPage } from './pages/Sessions.tsx';
import { SwitchProviderPage } from './pages/SwitchProvider.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { ConsolePage } from './pages/Console.tsx';
import { PromptsPage } from './pages/Prompts.tsx';
import { ReleasesPage } from './pages/Releases.tsx';
import { SchedulesPage } from './pages/Schedules.tsx';
import { QuestionPage } from './pages/Question.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
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
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
