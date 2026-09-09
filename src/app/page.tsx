'use client';

import { useEffect, useState } from 'react';
import { useProjectContext } from '@/context/ProjectContext';
import Header from '@/components/Header';
import Toolbar from '@/components/Toolbar';
import Sidebar from '@/components/Sidebar';
import GraphView from '@/components/GraphView';
import TimelineView from '@/components/TimelineView';
import DetailView from '@/components/DetailView';
import ImpactView from '@/components/ImpactView';
import GoalsView from '@/components/GoalsView';
import DriveView from '@/components/DriveView';
import StromView from '@/components/StromArchitecture';
import ProjectUniverseView from '@/components/ProjectUniverseView';
import LoadingState from '@/components/LoadingState';
import type { ViewType } from '@/lib/types';

const TOOLBAR_VIEWS: ViewType[] = ['graph', 'timeline', 'detail', 'impact'];
const VIEWS_OK_WHEN_EMPTY: ViewType[] = ['drive', 'goals', 'strom', 'universe'];

export default function Home() {
  const { projects, view, setView, refreshProjects, isLoading, isAdmin } = useProjectContext();

  // Track which views the user has already opened. Once a view is mounted we
  // keep it mounted and just toggle visibility — preserves component state,
  // scroll position, graph layout, and avoids re-running fetch effects.
  const [visited, setVisited] = useState<Set<ViewType>>(() => new Set([view]));

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    setVisited(prev => (prev.has(view) ? prev : new Set(prev).add(view)));
  }, [view]);

  // Drive Sync is admin-only (every /api/drive/* method requires it
  // server-side — Header.tsx locks the nav button too). This only catches a
  // 'drive' view restored from a prior session on mount; a basic user can't
  // click into it in the first place since Header.tsx disables that button.
  useEffect(() => {
    if (!isAdmin && view === 'drive') setView('detail');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // No projects yet — either the initial fetch is in flight or the DB is empty.
  // Either way, show a soft loading state instead of the deprecated Excel-upload
  // gating screen. Excel ingestion still lives in Drive Sync → "Upload CDIO Gating Pre-review Excel".
  // Views that don't need project data (Drive Sync, Goals, ArchFlow) render normally.
  if (projects.length === 0 && !VIEWS_OK_WHEN_EMPTY.includes(view)) {
    return (
      <div className="min-h-screen flex flex-col bg-bg">
        <Header />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-ink-4">
          <LoadingState label={isLoading ? 'Carregando…' : 'Sem dados ainda'} />
          {!isLoading && isAdmin && (
            <button
              onClick={() => setView('drive')}
              className="text-xs text-accent-text2 hover:underline -mt-12"
            >
              Ir para Drive Sync para popular o portfólio
            </button>
          )}
        </div>
      </div>
    );
  }

  const showToolbar = TOOLBAR_VIEWS.includes(view);

  return (
    <div className="min-h-screen flex flex-col bg-bg overflow-hidden" style={{ height: '100vh' }}>
      <Header />
      <div className={showToolbar ? 'contents' : 'hidden'}>
        <Toolbar />
      </div>

      <div className="flex-1 flex overflow-hidden">
        {visited.has('graph') && (
          <div className={view === 'graph' ? 'contents' : 'hidden'}><GraphView /></div>
        )}
        {visited.has('timeline') && (
          <div className={view === 'timeline' ? 'contents' : 'hidden'}><TimelineView /></div>
        )}
        {visited.has('detail') && (
          <div className={view === 'detail' ? 'contents' : 'hidden'}><DetailView /></div>
        )}
        {visited.has('impact') && (
          <div className={view === 'impact' ? 'contents' : 'hidden'}><ImpactView /></div>
        )}
        {visited.has('goals') && (
          <div className={view === 'goals' ? 'contents' : 'hidden'}><GoalsView /></div>
        )}
        {visited.has('drive') && (
          <div className={view === 'drive' ? 'contents' : 'hidden'}><DriveView /></div>
        )}
        {visited.has('strom') && (
          <div className={view === 'strom' ? 'contents' : 'hidden'}><StromView /></div>
        )}
        {visited.has('universe') && (
          <div className={view === 'universe' ? 'contents' : 'hidden'}><ProjectUniverseView /></div>
        )}

        <div className={showToolbar ? 'contents' : 'hidden'}><Sidebar /></div>
      </div>
    </div>
  );
}
