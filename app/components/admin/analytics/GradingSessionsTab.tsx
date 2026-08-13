/**
 * Grading Sessions Tab
 *
 * Display and filter grading results
 */

import { useEffect, useState } from 'react';
import { FileText, Award, Clock, AlertCircle } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { formatDateOnlyInTimeZone, formatTimeInTimeZone } from '@/lib/date';

interface GradingSession {
  id: string;
  status: string;
  normalizedScore: number | null;
  confidenceScore: number | null;
  requiresReview: boolean;
  gradingTokens: number | null;
  sparringTokens: number | null;
  convergenceCalls?: number;
  convergenceTokens?: number;
  gradingDuration: number | null;
  createdAt: string;
  uploadedFile: {
    fileName: string;
    userId: string;
    user: {
      name: string;
      email: string;
      picture: string;
    };
  };
  assignmentArea: {
    name: string;
  } | null;
  rubric: {
    name: string;
  };
}

export function GradingSessionsTab() {
  const { t } = useTranslation('admin');
  const [sessions, setSessions] = useState<GradingSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ requiresReview: '' });

  useEffect(() => {
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.requiresReview]); // Only re-fetch when filter value changes

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.requiresReview) params.set('requiresReview', filters.requiresReview);

      const response = await fetch(`/api/admin/analytics/grading-sessions?${params}`);
      const data = await response.json();
      setSessions(data.sessions || []);
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    } finally {
      setLoading(false);
    }
  };

  // Get user initials for avatar fallback
  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div>
      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-sm border-2 border-[#2B2B2B] bg-card p-3 dark:border-gray-200">
        <div className="flex items-center gap-3">
          <select
            value={filters.requiresReview}
            onChange={(e) => setFilters({ ...filters, requiresReview: e.target.value })}
            className="min-h-[40px] rounded-sm border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#D2691E] focus:outline-none focus:ring-2 focus:ring-[#D2691E]/20 dark:focus:border-[#E87D3E] dark:focus:ring-[#E87D3E]/20"
          >
            <option value="">{t('admin:analytics.gradingSessions.filters.all')}</option>
            <option value="true">{t('admin:analytics.gradingSessions.filters.requiresReview')}</option>
            <option value="false">{t('admin:analytics.gradingSessions.filters.noReviewNeeded')}</option>
          </select>
        </div>
        <div className="text-xs text-muted-foreground">
          <Trans
            i18nKey="admin:analytics.gradingSessions.showing"
            values={{ count: sessions.length }}
            components={{ 1: <span className="font-semibold text-foreground" /> }}
          />
        </div>
      </div>

      {/* Desktop Table View */}
      <div className="hidden rounded-sm border-2 border-[#2B2B2B] bg-card sm:block dark:border-gray-200">
        <div className="max-h-[68vh] overflow-auto">
          <table className="w-full min-w-[1200px]">
            <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur-sm">
              <tr className="border-b-2 border-[#2B2B2B]">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.gradingSessions.columns.student')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.gradingSessions.columns.file')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.gradingSessions.columns.assignment')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.gradingSessions.columns.rubric')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.gradingSessions.columns.score')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.gradingSessions.columns.confidence')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.gradingSessions.columns.gradingTokens')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.gradingSessions.columns.sparringTokens')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.gradingSessions.columns.geminiConverge')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.gradingSessions.columns.review')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                    {t('admin:analytics.gradingSessions.loading')}
                  </td>
                </tr>
              ) : sessions.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-muted-foreground">
                    {t('admin:analytics.gradingSessions.empty')}
                  </td>
                </tr>
              ) : (
                sessions.map((session, index) => (
                  <tr
                    key={session.id}
                    className={`transition-colors hover:bg-[#D2691E]/5 dark:hover:bg-[#E87D3E]/10 ${
                      index % 2 === 0 ? 'bg-transparent' : 'bg-muted/20'
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar className="border-2 border-[#2B2B2B] dark:border-gray-200">
                          <AvatarImage src={session.uploadedFile.user.picture} alt={session.uploadedFile.user.name} />
                          <AvatarFallback className="bg-transparent font-serif text-[#2B2B2B] dark:text-gray-200">
                            {getInitials(session.uploadedFile.user.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium text-foreground">{session.uploadedFile.user.name}</div>
                          <div className="text-xs text-muted-foreground">{session.uploadedFile.user.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-gray-400" />
                        <div>
                          <div
                            className="max-w-[220px] truncate text-sm text-foreground"
                            title={session.uploadedFile.fileName}
                          >
                            {session.uploadedFile.fileName}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatDateOnlyInTimeZone(session.createdAt)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{session.assignmentArea?.name || '-'}</td>
                    <td className="px-4 py-3 text-sm text-foreground">{session.rubric.name}</td>
                    <td className="px-4 py-3">
                      {session.normalizedScore !== null ? (
                        <div className="flex items-center gap-1">
                          <Award className="h-4 w-4 text-[#D2691E]" />
                          <span className="font-medium text-foreground">{session.normalizedScore.toFixed(1)}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {session.confidenceScore !== null ? (
                        <ConfidenceBadge score={session.confidenceScore} />
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 text-sm text-foreground">
                        <Clock className="h-3 w-3 text-gray-400" />
                        {session.gradingTokens?.toLocaleString() || '-'}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 text-sm text-foreground">
                        <Clock className="h-3 w-3 text-gray-400" />
                        {session.sparringTokens?.toLocaleString() || '-'}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm text-foreground">
                        <div>
                          {t('admin:analytics.gradingSessions.calls', { count: session.convergenceCalls ?? 0 })}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('admin:analytics.gradingSessions.tokensCount', { count: session.convergenceTokens ?? 0 })}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {session.requiresReview ? (
                        <div className="flex items-center gap-1 text-xs text-amber-700">
                          <AlertCircle className="h-4 w-4" />
                          {t('admin:analytics.gradingSessions.needsReview')}
                        </div>
                      ) : (
                        <span className="text-xs text-green-600">✓ {t('admin:analytics.gradingSessions.ok')}</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile Card View */}
      <div className="space-y-4 sm:hidden">
        {loading ? (
          <div className="py-8 text-center text-gray-500">{t('admin:analytics.gradingSessions.loading')}</div>
        ) : sessions.length === 0 ? (
          <div className="py-8 text-center text-gray-500">{t('admin:analytics.gradingSessions.empty')}</div>
        ) : (
          sessions.map((session) => (
            <div key={session.id} className="rounded-sm border-2 border-[#2B2B2B] bg-card p-4 dark:border-gray-200">
              <div className="mb-3 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <Avatar className="border-2 border-[#2B2B2B] dark:border-gray-200">
                    <AvatarImage src={session.uploadedFile.user.picture} alt={session.uploadedFile.user.name} />
                    <AvatarFallback className="bg-transparent font-serif text-[#2B2B2B] dark:text-gray-200">
                      {getInitials(session.uploadedFile.user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="font-medium text-gray-900">{session.uploadedFile.user.name}</div>
                    <div className="text-xs text-gray-500">{session.uploadedFile.user.email}</div>
                  </div>
                </div>
                <div>
                  {session.requiresReview ? (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                      <AlertCircle className="h-3 w-3" />
                      {t('admin:analytics.gradingSessions.needsReview')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded bg-green-50 px-2 py-1 text-xs font-medium text-green-700">
                      ✓ {t('admin:analytics.gradingSessions.ok')}
                    </span>
                  )}
                </div>
              </div>

              <hr className="my-3 border-gray-100" />

              {/* Row 2: File Info */}
              <div className="mb-3">
                <div className="flex items-center gap-2 text-sm text-gray-900">
                  <FileText className="h-4 w-4 text-gray-400" />
                  <span className="break-all font-medium" title={session.uploadedFile.fileName}>
                    {session.uploadedFile.fileName}
                  </span>
                </div>
                <div className="ml-6 text-xs text-gray-500">
                  {formatDateOnlyInTimeZone(session.createdAt)} • {formatTimeInTimeZone(session.createdAt)}
                </div>
              </div>

              {/* Row 3: Assignment Details */}
              <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded bg-gray-50 p-2">
                  <div className="text-gray-500">{t('admin:analytics.gradingSessions.columns.assignment')}</div>
                  <div className="font-medium text-gray-900 truncate">{session.assignmentArea?.name || '-'}</div>
                </div>
                <div className="rounded bg-gray-50 p-2">
                  <div className="text-gray-500">{t('admin:analytics.gradingSessions.columns.rubric')}</div>
                  <div className="font-medium text-gray-900 truncate">{session.rubric.name}</div>
                </div>
              </div>

              {/* Row 4: Metrics */}
              <div className="flex items-center justify-between rounded-sm border border-gray-100 bg-gray-50/50 p-3">
                <div>
                  <div className="text-xs text-gray-500">{t('admin:analytics.gradingSessions.columns.score')}</div>
                  <div className="flex items-center gap-1">
                    <Award className="h-4 w-4 text-[#D2691E]" />
                    <span className="font-bold text-gray-900">
                      {session.normalizedScore !== null ? session.normalizedScore.toFixed(1) : '-'}
                    </span>
                  </div>
                </div>

                <div className="text-center">
                  <div className="mb-1 text-xs text-gray-500">
                    {t('admin:analytics.gradingSessions.columns.confidence')}
                  </div>
                  {session.confidenceScore !== null ? (
                    <ConfidenceBadge score={session.confidenceScore} />
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </div>

                <div className="text-right">
                  <div className="text-xs text-gray-500">
                    {t('admin:analytics.gradingSessions.columns.gradingTokens')}
                  </div>
                  <div className="text-sm text-gray-900">
                    <div className="flex items-center justify-end gap-1">
                      <Clock className="h-3 w-3 text-gray-400" />
                      G: {session.gradingTokens?.toLocaleString() || '-'}
                    </div>
                    <div className="text-xs text-gray-500">
                      S: {session.sparringTokens?.toLocaleString() || '-'} / C: {session.convergenceCalls ?? 0}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ConfidenceBadge({ score }: { score: number }) {
  const percentage = Math.round(score * 100);
  const color =
    score > 0.8
      ? 'bg-green-100 text-green-800 border-green-300'
      : score >= 0.6
        ? 'bg-yellow-100 text-yellow-800 border-yellow-300'
        : 'bg-red-100 text-red-800 border-red-300';

  return (
    <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-medium ${color}`}>{percentage}%</span>
  );
}
