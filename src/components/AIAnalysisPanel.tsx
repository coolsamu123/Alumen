'use client';

import { useState } from 'react';
import { useProjectContext } from '@/context/ProjectContext';
import { ADMIN_ONLY_TITLE } from '@/lib/constants';
import type { ProjectSummary, AnalysisResult } from '@/lib/types';

interface Props {
  project: ProjectSummary;
  relatedProjects: ProjectSummary[];
}

export default function AIAnalysisPanel({ project, relatedProjects }: Props) {
  const { analyzeProjects, analyzeWithDocs, isAdmin } = useProjectContext();
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);

  const handlePairwise = async (peer: ProjectSummary) => {
    setIsAnalyzing(true);
    setError(null);
    setSelectedPeer(peer.projectId);
    try {
      const result = await analyzeProjects([project, peer], 'pairwise');
      setAnalysis(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleCluster = async () => {
    if (relatedProjects.length < 1) return;
    setIsAnalyzing(true);
    setError(null);
    setSelectedPeer(null);
    try {
      const result = await analyzeProjects([project, ...relatedProjects.slice(0, 5)], 'cluster');
      setAnalysis(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleDocAnalysis = async () => {
    const urls = [project.linkPositions, project.linkFolder, project.linkCIOO].filter(Boolean);
    if (urls.length === 0) {
      setError('No document links available for this project');
      return;
    }
    setIsAnalyzing(true);
    setError(null);
    try {
      const projects = selectedPeer
        ? [project, relatedProjects.find(r => r.projectId === selectedPeer)!]
        : [project];
      const result = await analyzeWithDocs(projects.filter(Boolean), urls);
      setAnalysis(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Document analysis failed');
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="border-t border-line-strong pt-3 mt-1">
      <div className="text-[10px] text-ink-muted font-bold tracking-widest mb-2">AI ANALYSIS (Gemini)</div>

      {/* Action buttons — each fires a live Gemini call via /api/analyze,
          which requires admin server-side (middleware.ts). Disabled rather
          than hidden for non-admins, per PLAN_USER_MANAGEMENT.md §5.2. */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {relatedProjects.slice(0, 3).map(peer => (
          <button key={peer.projectId}
            onClick={() => handlePairwise(peer)}
            disabled={!isAdmin || isAnalyzing}
            title={!isAdmin ? ADMIN_ONLY_TITLE : undefined}
            className="px-2 py-1 rounded text-[10px] bg-accent-soft border border-accent-border/50 text-accent-text hover:bg-accent-soft transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            vs {peer.projectId.replace('PRJ00', '')}
          </button>
        ))}

        {relatedProjects.length > 0 && (
          <button
            onClick={handleCluster}
            disabled={!isAdmin || isAnalyzing}
            title={!isAdmin ? ADMIN_ONLY_TITLE : undefined}
            className="px-2 py-1 rounded text-[10px] bg-purple-900/30 border border-purple-700/50 text-purple-300 hover:bg-purple-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cluster Analysis
          </button>
        )}

        {(project.linkFolder || project.linkPositions) && (
          <button
            onClick={handleDocAnalysis}
            disabled={!isAdmin || isAnalyzing}
            title={!isAdmin ? ADMIN_ONLY_TITLE : undefined}
            className="px-2 py-1 rounded text-[10px] bg-green-900/30 border border-green-700/50 text-green-300 hover:bg-green-900/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            + Documents
          </button>
        )}
      </div>

      {isAnalyzing && (
        <div className="text-[11px] text-ink-4 animate-pulse">Analyzing with Gemini...</div>
      )}

      {error && (
        <div className="text-[11px] text-red-400 bg-red-900/20 rounded p-2 mb-2">{error}</div>
      )}

      {analysis && !isAnalyzing && (
        <div className="space-y-2.5 animate-fadeIn">
          {analysis.themes.length > 0 && (
            <div>
              <div className="text-[10px] text-accent-text2 font-semibold mb-1">THEMES</div>
              {analysis.themes.map((t, i) => (
                <div key={i} className="text-[11px] text-ink-3 pl-2 border-l-2 border-accent-border mb-1">{t}</div>
              ))}
            </div>
          )}

          {analysis.synergies.length > 0 && (
            <div>
              <div className="text-[10px] text-green-400 font-semibold mb-1">SYNERGIES</div>
              {analysis.synergies.map((s, i) => (
                <div key={i} className="text-[11px] text-ink-3 pl-2 border-l-2 border-green-700 mb-1">{s}</div>
              ))}
            </div>
          )}

          {analysis.risks.length > 0 && (
            <div>
              <div className="text-[10px] text-red-400 font-semibold mb-1">RISKS</div>
              {analysis.risks.map((r, i) => (
                <div key={i} className="text-[11px] text-ink-3 pl-2 border-l-2 border-red-700 mb-1">{r}</div>
              ))}
            </div>
          )}

          {analysis.recommendations.length > 0 && (
            <div>
              <div className="text-[10px] text-yellow-400 font-semibold mb-1">RECOMMENDATIONS</div>
              {analysis.recommendations.map((r, i) => (
                <div key={i} className="text-[11px] text-ink-3 pl-2 border-l-2 border-yellow-700 mb-1">{r}</div>
              ))}
            </div>
          )}

          <div className="text-[10px] text-ink-muted text-right">
            AI Similarity: {Math.round(analysis.similarityScore * 100)}% · {analysis.modelUsed}
          </div>
        </div>
      )}
    </div>
  );
}
