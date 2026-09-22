import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router';
import { App } from './App.tsx';
import { BoardPage } from './pages/Board.tsx';
import { ItemPage } from './pages/Item.tsx';
import { SessionsPage } from './pages/Sessions.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { ConsolePage } from './pages/Console.tsx';
import { PromptsPage } from './pages/Prompts.tsx';
import { ReleasesPage } from './pages/Releases.tsx';
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
          <Route path="console" element={<ConsolePage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
