/**
 * Chat Sessions Tab
 *
 * Display and filter agent chat sessions
 */

import { useEffect, useState } from 'react';
import { Calendar, MessageSquare, Clock } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { formatDateOnlyInTimeZone, formatTimeInTimeZone } from '@/lib/date';

interface ChatSession {
  id: string;
  title: string | null;
  userRole: string;
  modelProvider: string | null; // Add modelProvider
  totalTokens: number;
  totalDuration: number;
  status: string;
  createdAt: string;
  user: {
    name: string;
    email: string;
    picture?: string | null;
  };
  _count: {
    messages: number;
    stepLogs: number;
  };
}

export function ChatSessionsTab() {
  const { t } = useTranslation(['admin', 'common']);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ role: '', status: '' });

  useEffect(() => {
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.role, filters.status]); // Only re-fetch when filter values change

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.role) params.set('role', filters.role);
      if (filters.status) params.set('status', filters.status);

      const response = await fetch(`/api/admin/analytics/chat-sessions?${params}`);
      const data = await response.json();
      setSessions(data.sessions || []);
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-sm border-2 border-[#2B2B2B] bg-card p-3 dark:border-gray-200">
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={filters.role}
            onChange={(e) => setFilters({ ...filters, role: e.target.value })}
            className="min-h-[40px] rounded-sm border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#D2691E] focus:outline-none focus:ring-2 focus:ring-[#D2691E]/20 dark:focus:border-[#E87D3E] dark:focus:ring-[#E87D3E]/20"
          >
            <option value="">{t('admin:analytics.chatSessions.filters.allRoles')}</option>
            <option value="TEACHER">{t('common:roles.teacher')}</option>
            <option value="STUDENT">{t('common:roles.student')}</option>
            <option value="ADMIN">{t('common:roles.admin')}</option>
          </select>

          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            className="min-h-[40px] rounded-sm border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[#D2691E] focus:outline-none focus:ring-2 focus:ring-[#D2691E]/20 dark:focus:border-[#E87D3E] dark:focus:ring-[#E87D3E]/20"
          >
            <option value="">{t('admin:analytics.chatSessions.filters.allStatus')}</option>
            <option value="ACTIVE">{t('admin:analytics.chatSessions.filters.statusActive')}</option>
            <option value="COMPLETED">{t('admin:analytics.chatSessions.filters.statusCompleted')}</option>
            <option value="ERROR">{t('admin:analytics.chatSessions.filters.statusError')}</option>
          </select>
        </div>
        <div className="text-xs text-muted-foreground">
          <Trans
            i18nKey="admin:analytics.chatSessions.showing"
            values={{ count: sessions.length }}
            components={{ 1: <span className="font-semibold text-foreground" /> }}
          />
        </div>
      </div>

      {/* Desktop Table View */}
      <div className="hidden rounded-sm border-2 border-[#2B2B2B] bg-card sm:block dark:border-gray-200">
        <div className="max-h-[68vh] overflow-auto">
          <table className="w-full min-w-[1080px]">
            <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur-sm">
              <tr className="border-b-2 border-[#2B2B2B]">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.chatSessions.columns.session')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.chatSessions.columns.user')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.chatSessions.columns.role')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.chatSessions.columns.messages')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.chatSessions.columns.model')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.chatSessions.columns.tokens')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.chatSessions.columns.duration')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('admin:analytics.chatSessions.columns.status')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    {t('admin:analytics.chatSessions.loading')}
                  </td>
                </tr>
              ) : sessions.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    {t('admin:analytics.chatSessions.empty')}
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
                      <div className="flex items-center gap-2">
                        <MessageSquare className="h-4 w-4 text-gray-400" />
                        <div>
                          <div
                            className="max-w-[260px] truncate font-medium text-foreground"
                            title={session.title || t('admin:analytics.chatSessions.untitled')}
                          >
                            {session.title || t('admin:analytics.chatSessions.untitled')}
                          </div>
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Calendar className="h-3 w-3" />
                            {formatDateOnlyInTimeZone(session.createdAt)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar className="border-2 border-[#2B2B2B] dark:border-gray-200">
                          <AvatarImage src={session.user.picture || undefined} alt={session.user.name} />
                          <AvatarFallback className="bg-transparent font-serif text-[#2B2B2B] dark:text-gray-200">
                            {session.user.name.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="text-sm font-medium text-foreground">{session.user.name}</div>
                          <div
                            className="max-w-[220px] truncate text-xs text-muted-foreground"
                            title={session.user.email}
                          >
                            {session.user.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full border border-[#D2691E] bg-[#D2691E]/10 px-2 py-1 text-xs font-medium text-[#D2691E]">
                        {t(`common:roles.${session.userRole.toLowerCase()}`, session.userRole)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{session._count.messages}</td>
                    <td className="px-4 py-3">
                      {session.modelProvider ? (
                        <span
                          className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${getModelBadgeClass(session.modelProvider)}`}
                        >
                          {session.modelProvider === 'local'
                            ? 'Local (vLLM)'
                            : session.modelProvider === 'gemini'
                              ? 'Gemini 2.5'
                              : session.modelProvider}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">{formatTokens(session.totalTokens)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 text-sm text-foreground">
                        <Clock className="h-3 w-3 text-gray-400" />
                        {formatDuration(session.totalDuration)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={session.status} />
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
          <div className="py-8 text-center text-gray-500">{t('admin:analytics.chatSessions.loading')}</div>
        ) : sessions.length === 0 ? (
          <div className="py-8 text-center text-gray-500">{t('admin:analytics.chatSessions.empty')}</div>
        ) : (
          sessions.map((session) => (
            <div key={session.id} className="rounded-sm border-2 border-[#2B2B2B] bg-card p-4 dark:border-gray-200">
              {/* Row 1: User & Status */}
              <div className="mb-3 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <Avatar className="border-2 border-[#2B2B2B] dark:border-gray-200">
                    <AvatarImage src={session.user.picture || undefined} alt={session.user.name} />
                    <AvatarFallback className="bg-transparent font-serif text-[#2B2B2B] dark:text-gray-200">
                      {session.user.name.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <div className="font-medium text-gray-900">{session.user.name}</div>
                    <div className="text-xs text-gray-500">{session.user.email}</div>
                  </div>
                </div>
                <StatusBadge status={session.status} />
              </div>

              <hr className="my-3 border-gray-100" />

              {/* Row 2: Session Title */}
              <div className="mb-3">
                <div className="flex items-center gap-2 text-sm text-gray-900">
                  <MessageSquare className="h-4 w-4 text-gray-400" />
                  <span className="font-medium">{session.title || t('admin:analytics.chatSessions.untitled')}</span>
                </div>
                <div className="ml-6 text-xs text-gray-500">
                  {formatDateOnlyInTimeZone(session.createdAt)} • {formatTimeInTimeZone(session.createdAt)}
                </div>
              </div>

              {/* Row 3: Metrics */}
              <div className="flex items-center justify-between rounded-sm border border-gray-100 bg-gray-50/50 p-3">
                <div>
                  <div className="text-xs text-gray-500">{t('admin:analytics.chatSessions.columns.role')}</div>
                  <span className="inline-flex rounded-full border border-[#D2691E] bg-[#D2691E]/10 px-2 py-0.5 text-xs font-medium text-[#D2691E]">
                    {t(`common:roles.${session.userRole.toLowerCase()}`, session.userRole)}
                  </span>
                </div>

                <div className="text-center">
                  <div className="text-xs text-gray-500">{t('admin:analytics.chatSessions.columns.messages')}</div>
                  <span className="font-medium text-gray-900">{session._count.messages}</span>
                </div>

                <div className="text-center">
                  <div className="text-xs text-gray-500">{t('admin:analytics.chatSessions.columns.model')}</div>
                  <span className="text-sm font-medium text-gray-900">{session.modelProvider || '-'}</span>
                </div>

                <div className="text-right">
                  <div className="text-xs text-gray-500">{t('admin:analytics.chatSessions.columns.tokens')}</div>
                  <div className="font-medium text-gray-900">{formatTokens(session.totalTokens)}</div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function getModelBadgeClass(modelProvider: string | null): string {
  if (modelProvider === 'local') {
    return 'bg-[#D2691E]/10 text-[#D2691E] ring-[#D2691E]/25 dark:bg-[#E87D3E]/15 dark:text-[#E87D3E] dark:ring-[#E87D3E]/35';
  }

  if (modelProvider === 'gemini') {
    return 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-400/30';
  }

  return 'bg-muted text-muted-foreground ring-border';
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('admin');

  const colors = {
    ACTIVE: 'bg-blue-100 text-blue-800 border-blue-300',
    COMPLETED: 'bg-green-100 text-green-800 border-green-300',
    ERROR: 'bg-red-100 text-red-800 border-red-300',
  };

  // ACTIVE -> filters.statusActive, COMPLETED -> filters.statusCompleted, ...
  const labelKey = `analytics.chatSessions.filters.status${status.charAt(0)}${status.slice(1).toLowerCase()}`;

  return (
    <span
      className={`inline-flex rounded-full border px-2 py-1 text-xs font-medium ${
        colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800 border-gray-300'
      }`}
    >
      {t(labelKey, status)}
    </span>
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
