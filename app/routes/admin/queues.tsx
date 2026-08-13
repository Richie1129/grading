import { useRouteError, isRouteErrorResponse } from 'react-router';
import { useEffect, useState } from 'react';
import type { Route } from './+types/queues';
import { getUserId } from '@/services/auth.server';
import { db } from '@/lib/db.server';
import { Trash2, RefreshCw, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDateTimeInTimeZone, formatTimeInTimeZone } from '@/lib/date';
import { ErrorPage } from '@/components/errors/ErrorPage';
import type { JobDetail } from '@/services/queue-jobs.server';
import type { CleanupPreview } from '@/services/queue-cleanup.server';

/**
 * Admin Queue Monitoring Dashboard
 *
 * Architectural Editorial Minimalism style dashboard for BullMQ queue monitoring
 * Real-time monitoring with cleanup functionality
 */

export async function loader({ request }: Route.LoaderArgs) {
  // Authentication & Authorization
  const userId = await getUserId(request);
  if (!userId) {
    throw new Response('Unauthorized', { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, name: true, email: true },
  });

  if (user?.role !== 'ADMIN') {
    throw new Response('Forbidden: Admin access required', { status: 403 });
  }

  return { user };
}

interface QueueStatus {
  queue: string;
  status: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  };
  rateLimiting: {
    isRateLimited: boolean;
    remainingTtl: number;
    config: {
      max: number;
      duration: number;
    };
  };
  mode: string;
  isProcessing: boolean;
  timestamp: string;
}

interface CleanupResult {
  before: Record<string, number>;
  after: Record<string, number>;
  removed: Record<string, number>;
  timestamp: string;
}

/**
 * These endpoints are consumed with fetch().json(), so the Date fields declared on
 * the server-side types have already been serialised to ISO strings by the time
 * they reach this component.
 */
type SerializedJobDetail = Omit<JobDetail, 'addedAt' | 'processedAt'> & {
  addedAt: string;
  processedAt?: string;
};

type SerializedCleanupPreview = Omit<CleanupPreview, 'activeJobs' | 'recentJobs'> & {
  activeJobs: SerializedJobDetail[];
  recentJobs: SerializedJobDetail[];
};

export default function QueuesPage() {
  const { t } = useTranslation(['queue', 'common']);
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCleanupDialog, setShowCleanupDialog] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<SerializedCleanupPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [jobDetails, setJobDetails] = useState<SerializedJobDetail[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [showJobDetails, setShowJobDetails] = useState(false);

  // Load status once on mount
  useEffect(() => {
    fetchStatus();
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch('/api/admin/queue-status');
      const response = await res.json();

      // API returns { success: true, data: {...} }
      if (response.success && response.data) {
        const data = response.data;
        setStatus({
          queue: data.queue,
          status: data.status || {
            waiting: 0,
            active: 0,
            completed: 0,
            failed: 0,
            delayed: 0,
            paused: 0,
          },
          rateLimiting: data.rateLimiting,
          mode: data.mode || 'unknown',
          isProcessing: data.isProcessing || false,
          timestamp: data.timestamp || new Date().toISOString(),
        });
        setError(null);

        // Auto-fetch job details if there are active or waiting jobs
        if (data.status.active > 0 || data.status.waiting > 0) {
          fetchJobDetails();
        }
      } else {
        setError(response.error || t('queue:errors.fetchStatusFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('queue:errors.fetchStatusFailed'));
    } finally {
      setLoading(false);
    }
  }

  async function fetchJobDetails() {
    try {
      setLoadingJobs(true);
      const res = await fetch('/api/admin/queue-jobs');
      const data = await res.json();

      if (data.success) {
        setJobDetails(data.jobs || []);
      }
    } catch (err) {
      console.error('Failed to fetch job details:', err);
    } finally {
      setLoadingJobs(false);
    }
  }

  // Fetch cleanup preview when opening dialog
  async function handleOpenCleanupDialog() {
    setLoadingPreview(true);
    setShowCleanupDialog(true);

    try {
      const res = await fetch('/api/admin/cleanup-preview');
      const data = await res.json();

      if (data.success) {
        setCleanupPreview(data.preview);
      } else {
        setError(t('queue:errors.loadPreviewFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('queue:errors.loadPreviewFailed'));
    } finally {
      setLoadingPreview(false);
    }
  }

  const handleCleanup = async () => {
    setCleanupLoading(true);
    setCleanupResult(null);
    try {
      const response = await fetch('/api/admin/cleanup-jobs', {
        method: 'POST',
      });

      const data = await response.json();
      if (data.success) {
        setCleanupResult(data.data);
        // Refresh status immediately after cleanup
        setTimeout(() => {
          window.location.reload();
        }, 3000);
      } else {
        setError(data.message || t('queue:errors.cleanupFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('queue:errors.cleanupFailed'));
    } finally {
      setCleanupLoading(false);
      setShowCleanupDialog(false);
    }
  };

  if (error) {
    return (
      <div className="min-h-screen">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="border-2 border-destructive/30 p-8">
            <div className="flex items-start gap-4">
              <AlertTriangle className="h-6 w-6 text-destructive flex-shrink-0 mt-1" strokeWidth={1.5} />
              <div>
                <h2 className="font-serif text-2xl font-light text-destructive mb-2">{t('queue:systemError')}</h2>
                <p className="text-gray-600 dark:text-gray-400 mb-2">{error}</p>
                <p className="text-sm text-gray-500 dark:text-gray-500">{t('queue:errorMessage')}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-8">
          <div className="flex items-center gap-3">
            <RefreshCw className="h-5 w-5 text-[#D2691E] dark:text-[#E87D3E] animate-spin" strokeWidth={1.5} />
            <p className="font-serif text-lg text-gray-600 dark:text-gray-400">{t('queue:loading')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!status) return null;

  const isLimited = status.rateLimiting.isRateLimited;
  const totalJobs = status.status.waiting + status.status.active + status.status.completed + status.status.failed;
  const totalRemovable =
    status.status.waiting +
    status.status.failed +
    status.status.completed +
    status.status.delayed +
    status.status.active;

  return (
    <div className="min-h-screen">
      {/* Header - Architectural Sketch Style */}
      <header className="border-b-2 border-[#2B2B2B] dark:border-gray-200">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-serif text-3xl font-light tracking-tight text-[#2B2B2B] dark:text-gray-100">
                {t('queue:title')}
              </h1>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('queue:subtitle')}</p>
            </div>
            <div className="flex items-center gap-4">
              {/* Last Updated */}
              <div className="text-right">
                <p className="text-sm text-gray-600 dark:text-gray-400">{t('queue:lastUpdated')}</p>
                <p className="font-serif text-lg font-light text-[#2B2B2B] dark:text-gray-100">
                  {status?.timestamp ? formatTimeInTimeZone(status.timestamp) : '-'}
                </p>
              </div>

              {/* Manual Refresh Button */}
              <button
                onClick={fetchStatus}
                disabled={loading}
                className="border-2 border-[#2B2B2B] dark:border-gray-200 px-4 py-2 transition-all hover:bg-[#2B2B2B] hover:text-white dark:hover:bg-gray-200 dark:hover:text-[#2B2B2B] disabled:opacity-30 flex items-center gap-2"
                title={t('common:refresh')}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
                <span className="text-sm">{t('common:refresh')}</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Cleanup Success Message */}
        {cleanupResult && (
          <div className="mb-8 border-2 border-[#D2691E] dark:border-[#E87D3E] bg-[#D2691E]/5 dark:bg-[#E87D3E]/5 p-6">
            <h3 className="font-serif text-xl font-light text-[#D2691E] dark:text-[#E87D3E] mb-4">
              {t('queue:cleanup.successTitle')}
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              <div>
                <p className="text-gray-600 dark:text-gray-400">{t('queue:cleanup.failedJobs')}</p>
                <p className="font-mono font-bold text-[#2B2B2B] dark:text-gray-100">{cleanupResult.removed.failed}</p>
              </div>
              <div>
                <p className="text-gray-600 dark:text-gray-400">{t('queue:cleanup.completedJobs')}</p>
                <p className="font-mono font-bold text-[#2B2B2B] dark:text-gray-100">
                  {cleanupResult.removed.completed}
                </p>
              </div>
              <div>
                <p className="text-gray-600 dark:text-gray-400">{t('queue:cleanup.waitingJobs')}</p>
                <p className="font-mono font-bold text-[#2B2B2B] dark:text-gray-100">{cleanupResult.removed.waiting}</p>
              </div>
              <div>
                <p className="text-gray-600 dark:text-gray-400">{t('queue:cleanup.delayedJobs')}</p>
                <p className="font-mono font-bold text-[#2B2B2B] dark:text-gray-100">{cleanupResult.removed.delayed}</p>
              </div>
              <div>
                <p className="text-gray-600 dark:text-gray-400">{t('queue:cleanup.activeJobs')}</p>
                <p className="font-mono font-bold text-[#2B2B2B] dark:text-gray-100">{cleanupResult.removed.active}</p>
              </div>
            </div>
            <p className="mt-4 text-xs text-gray-500 dark:text-gray-500">{t('queue:cleanup.successMessage')}</p>
          </div>
        )}

        {/* Queue Statistics - De-boxed Layout */}
        <div className="mb-12">
          <div className="flex items-end justify-between mb-6">
            <div>
              <h2 className="font-serif text-2xl font-light text-[#2B2B2B] dark:text-gray-100">
                {t('queue:statistics.title')}
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('queue:statistics.subtitle')}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-gray-600 dark:text-gray-400">{t('queue:statistics.totalJobs')}</p>
              <p className="font-serif text-4xl font-light text-[#2B2B2B] dark:text-gray-100">{totalJobs}</p>
            </div>
          </div>

          {/* Job Status Grid - Architectural Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {/* Waiting */}
            <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-5 transition-all hover:border-[#D2691E] dark:hover:border-[#E87D3E]">
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                {t('queue:statistics.waiting').toUpperCase()}
              </p>
              <p className="font-serif text-4xl font-light text-[#2B2B2B] dark:text-gray-100">
                {status.status.waiting}
              </p>
            </div>

            {/* Active - Terracotta Accent */}
            <div className="border-2 border-[#D2691E] dark:border-[#E87D3E] bg-[#D2691E]/5 dark:bg-[#E87D3E]/5 p-5">
              <p className="text-xs font-semibold text-[#D2691E] dark:text-[#E87D3E] mb-2">
                {t('queue:statistics.active').toUpperCase()}
              </p>
              <p className="font-serif text-4xl font-light text-[#D2691E] dark:text-[#E87D3E]">
                {status.status.active}
              </p>
            </div>

            {/* Completed */}
            <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-5 transition-all hover:border-[#D2691E] dark:hover:border-[#E87D3E]">
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                {t('queue:statistics.completed').toUpperCase()}
              </p>
              <p className="font-serif text-4xl font-light text-[#2B2B2B] dark:text-gray-100">
                {status.status.completed}
              </p>
            </div>

            {/* Failed */}
            <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-5 transition-all hover:border-[#D2691E] dark:hover:border-[#E87D3E]">
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                {t('queue:statistics.failed').toUpperCase()}
              </p>
              <p className="font-serif text-4xl font-light text-[#2B2B2B] dark:text-gray-100">{status.status.failed}</p>
            </div>

            {/* Delayed */}
            <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-5 transition-all hover:border-[#D2691E] dark:hover:border-[#E87D3E]">
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                {t('queue:statistics.delayed').toUpperCase()}
              </p>
              <p className="font-serif text-4xl font-light text-[#2B2B2B] dark:text-gray-100">
                {status.status.delayed}
              </p>
            </div>

            {/* Paused */}
            <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-5 transition-all hover:border-[#D2691E] dark:hover:border-[#E87D3E]">
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                {t('queue:statistics.paused').toUpperCase()}
              </p>
              <p className="font-serif text-4xl font-light text-[#2B2B2B] dark:text-gray-100">{status.status.paused}</p>
            </div>
          </div>
        </div>

        {/* Active/Waiting Jobs Details - Architectural Editorial Style */}
        {(status.status.active > 0 || status.status.waiting > 0) && (
          <div className="my-12">
            <div className="flex items-end justify-between mb-6">
              <div>
                <h2 className="font-serif text-2xl font-light text-[#2B2B2B] dark:text-gray-100">
                  {t('queue:jobDetails.title')}
                </h2>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {t('queue:statistics.active')}: {status.status.active} · {t('queue:statistics.waiting')}:{' '}
                  {status.status.waiting}
                </p>
              </div>
              <button
                onClick={() => {
                  setShowJobDetails(!showJobDetails);
                  if (!showJobDetails) fetchJobDetails();
                }}
                className="border border-[#2B2B2B] dark:border-gray-200 px-4 py-2 text-sm transition-all hover:bg-[#2B2B2B] hover:text-white dark:hover:bg-gray-200 dark:hover:text-[#2B2B2B] flex items-center gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${loadingJobs ? 'animate-spin' : ''}`} strokeWidth={1.5} />
                {showJobDetails ? t('common:hide') : t('common:show')}
              </button>
            </div>

            {showJobDetails && (
              <div className="space-y-6">
                {loadingJobs ? (
                  <div className="text-center py-12">
                    <RefreshCw
                      className="h-6 w-6 text-[#D2691E] dark:text-[#E87D3E] animate-spin mx-auto mb-3"
                      strokeWidth={1.5}
                    />
                    <p className="text-sm text-gray-600 dark:text-gray-400">{t('queue:loading')}</p>
                  </div>
                ) : jobDetails.length > 0 ? (
                  jobDetails.map((job) => (
                    <div
                      key={job.jobId}
                      className="border border-[#2B2B2B] dark:border-gray-200 p-6 transition-all hover:border-[#D2691E] dark:hover:border-[#E87D3E]"
                    >
                      {/* Job Header with Status Badge */}
                      <div className="flex items-start justify-between mb-4 pb-4 border-b border-gray-200 dark:border-gray-700">
                        <div className="flex-1">
                          <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1">
                            {t('queue:jobDetails.user').toUpperCase()}
                          </p>
                          <p className="font-serif text-lg font-light text-[#2B2B2B] dark:text-gray-100">
                            {job.user?.name || t('queue:cleanup.preview.noUserInfo')}
                          </p>
                        </div>
                        <div
                          className={`px-3 py-1 border ${
                            job.status === 'active'
                              ? 'border-[#D2691E] dark:border-[#E87D3E] bg-[#D2691E]/5 dark:bg-[#E87D3E]/5'
                              : 'border-[#2B2B2B] dark:border-gray-200'
                          }`}
                        >
                          <span
                            className={`text-xs font-semibold ${
                              job.status === 'active'
                                ? 'text-[#D2691E] dark:text-[#E87D3E]'
                                : 'text-[#2B2B2B] dark:text-gray-100'
                            }`}
                          >
                            {job.status === 'active'
                              ? t('queue:jobDetails.active').toUpperCase()
                              : t('queue:jobDetails.waiting').toUpperCase()}
                          </span>
                        </div>
                      </div>

                      {/* Job Details Grid - De-boxed Layout */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-4">
                        <div>
                          <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">
                            {t('queue:jobDetails.course')}
                          </p>
                          <p className="text-sm text-[#2B2B2B] dark:text-gray-100">
                            {job.assignment?.courseName || '-'}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">
                            {t('queue:jobDetails.assignment')}
                          </p>
                          <p className="text-sm text-[#2B2B2B] dark:text-gray-100">
                            {job.assignment?.name || t('queue:cleanup.preview.noAssignmentInfo')}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-600 dark:text-gray-400 mb-1">{t('queue:jobDetails.file')}</p>
                          <p className="text-sm text-gray-700 dark:text-gray-300 font-mono truncate">
                            {job.file?.fileName || '-'}
                          </p>
                        </div>
                      </div>

                      {/* Timestamp Footer */}
                      <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                        <p className="text-xs text-gray-500 dark:text-gray-500">
                          {t('queue:jobDetails.time')}: {formatDateTimeInTimeZone(job.addedAt)}
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-12 border border-dashed border-gray-300 dark:border-gray-600">
                    <p className="text-sm text-gray-500 dark:text-gray-400">{t('queue:jobDetails.noJobs')}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Rate Limiting Section */}
        <div className="mb-12">
          <h2 className="font-serif text-2xl font-light text-[#2B2B2B] dark:text-gray-100 mb-6">
            {t('queue:rateLimiting.title')}
          </h2>

          <div
            className={`border-2 p-6 transition-all ${
              isLimited
                ? 'border-destructive bg-destructive/5'
                : 'border-[#D2691E] dark:border-[#E87D3E] bg-[#D2691E]/5 dark:bg-[#E87D3E]/5'
            }`}
          >
            <div className="flex items-center justify-between mb-6">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">{t('queue:rateLimiting.configuration')}</p>
                <p className="font-mono text-lg text-[#2B2B2B] dark:text-gray-100">
                  {t('queue:rateLimiting.requestsPerSecond', {
                    max: status.rateLimiting.config.max,
                    duration: status.rateLimiting.config.duration / 1000,
                  })}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-gray-600 dark:text-gray-400">{t('queue:rateLimiting.status')}</p>
                <div className="flex items-center gap-2 justify-end">
                  <span
                    className={`w-3 h-3 rounded-full animate-pulse ${isLimited ? 'bg-destructive' : 'bg-[#D2691E] dark:bg-[#E87D3E]'}`}
                  ></span>
                  <p
                    className={`font-serif text-lg ${isLimited ? 'text-destructive' : 'text-[#D2691E] dark:text-[#E87D3E]'}`}
                  >
                    {isLimited
                      ? `${t('queue:rateLimiting.limited')} (${Math.ceil(status.rateLimiting.remainingTtl / 1000)}s)`
                      : t('queue:rateLimiting.active')}
                  </p>
                </div>
              </div>
            </div>

            {/* Usage Progress Bar */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">{t('queue:rateLimiting.currentUsage')}</span>
                <span className="font-mono text-[#2B2B2B] dark:text-gray-100">
                  {status.status.active} / {status.rateLimiting.config.max}
                  <span className="ml-2 text-gray-500">
                    ({Math.round((status.status.active / status.rateLimiting.config.max) * 100)}%)
                  </span>
                </span>
              </div>
              <div className="h-2 border-2 border-[#2B2B2B] dark:border-gray-200 overflow-hidden">
                <div
                  className="h-full transition-all duration-500"
                  style={{
                    width: `${Math.min((status.status.active / status.rateLimiting.config.max) * 100, 100)}%`,
                    backgroundColor: isLimited ? 'hsl(var(--destructive))' : '#D2691E',
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Cleanup Section - Action Zone with Dashed Border */}
        <div className="border-2 border-dashed border-[#D2691E] dark:border-[#E87D3E] p-8 bg-[#D2691E]/5 dark:bg-[#E87D3E]/5">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h2 className="font-serif text-2xl font-light text-[#2B2B2B] dark:text-gray-100 mb-2">
                {t('queue:cleanup.title')}
              </h2>
              <p
                className="text-sm text-gray-600 dark:text-gray-400 mb-4 max-w-2xl"
                dangerouslySetInnerHTML={{ __html: t('queue:cleanup.description') }}
              />
              <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <span>{t('queue:cleanup.jobsToRemove')}</span>
                <span className="font-mono font-bold text-[#D2691E] dark:text-[#E87D3E]">{totalRemovable}</span>
              </div>
            </div>

            <button
              onClick={handleOpenCleanupDialog}
              disabled={totalRemovable === 0}
              className="border-2 border-[#D2691E] dark:border-[#E87D3E] px-6 py-3 font-serif text-lg transition-all hover:bg-[#D2691E] hover:text-white dark:hover:bg-[#E87D3E] dark:hover:text-[#2B2B2B] disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-current"
            >
              <div className="flex items-center gap-2">
                <Trash2 className="h-5 w-5" strokeWidth={1.5} />
                <span>{t('queue:cleanup.button')}</span>
              </div>
            </button>
          </div>
        </div>

        {/* System Info Footer */}
        <div className="mt-12 pt-8 border-t-2 border-[#2B2B2B] dark:border-gray-200">
          <div className="grid grid-cols-2 gap-8 text-center">
            <div>
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                {t('queue:systemInfo.queueEngine').toUpperCase()}
              </p>
              <p className="font-mono text-lg text-[#2B2B2B] dark:text-gray-100">{t('queue:systemInfo.bullmq')}</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">
                {t('queue:systemInfo.queueState').toUpperCase()}
              </p>
              <p className="font-mono text-lg text-[#2B2B2B] dark:text-gray-100">
                {status?.isProcessing ? t('queue:systemInfo.processing') : t('queue:systemInfo.idle')}
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Cleanup Confirmation Dialog with Preview */}
      {showCleanupDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="border-2 border-[#2B2B2B] dark:border-gray-200 bg-background max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            {/* Dialog Header */}
            <div className="sticky top-0 bg-background border-b-2 border-[#2B2B2B] dark:border-gray-200 p-6">
              <div className="flex items-start gap-4">
                <AlertTriangle
                  className="h-6 w-6 text-[#D2691E] dark:text-[#E87D3E] flex-shrink-0 mt-1"
                  strokeWidth={1.5}
                />
                <div className="flex-1">
                  <h3 className="font-serif text-2xl font-light text-[#2B2B2B] dark:text-gray-100 mb-2">
                    {t('queue:cleanup.confirmTitle')}
                  </h3>
                  <p
                    className="text-sm text-gray-600 dark:text-gray-400"
                    dangerouslySetInnerHTML={{ __html: t('queue:cleanup.confirmMessage', { count: totalRemovable }) }}
                  />
                </div>
              </div>
            </div>

            {/* Preview Content */}
            <div className="p-6 space-y-6">
              {loadingPreview ? (
                <div className="text-center py-8">
                  <RefreshCw
                    className="h-8 w-8 text-[#D2691E] dark:text-[#E87D3E] animate-spin mx-auto mb-3"
                    strokeWidth={1.5}
                  />
                  <p className="text-gray-600 dark:text-gray-400">{t('queue:cleanup.preview.loading')}</p>
                </div>
              ) : cleanupPreview ? (
                <>
                  {/* Active Jobs Warning */}
                  {cleanupPreview.byStatus.active > 0 && (
                    <div className="border-2 border-[#D2691E] dark:border-[#E87D3E] bg-[#D2691E]/5 dark:bg-[#E87D3E]/5 p-4">
                      <p className="text-sm font-medium text-[#D2691E] dark:text-[#E87D3E]">
                        {t('queue:cleanup.preview.activeWarning', { count: cleanupPreview.byStatus.active })}
                      </p>
                    </div>
                  )}

                  {/* Summary Stats */}
                  <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
                    <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-3 text-center">
                      <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">
                        {t('queue:statistics.waiting').toUpperCase()}
                      </div>
                      <div className="font-mono text-xl text-[#2B2B2B] dark:text-gray-100">
                        {cleanupPreview.byStatus.waiting}
                      </div>
                    </div>
                    <div className="border-2 border-[#D2691E] dark:border-[#E87D3E] bg-[#D2691E]/5 dark:bg-[#E87D3E]/5 p-3 text-center">
                      <div className="text-xs text-[#D2691E] dark:text-[#E87D3E] mb-1">
                        {t('queue:statistics.active').toUpperCase()}
                      </div>
                      <div className="font-mono text-xl text-[#D2691E] dark:text-[#E87D3E]">
                        {cleanupPreview.byStatus.active}
                      </div>
                    </div>
                    <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-3 text-center">
                      <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">
                        {t('queue:statistics.completed').toUpperCase()}
                      </div>
                      <div className="font-mono text-xl text-[#2B2B2B] dark:text-gray-100">
                        {cleanupPreview.byStatus.completed}
                      </div>
                    </div>
                    <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-3 text-center">
                      <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">
                        {t('queue:statistics.failed').toUpperCase()}
                      </div>
                      <div className="font-mono text-xl text-[#2B2B2B] dark:text-gray-100">
                        {cleanupPreview.byStatus.failed}
                      </div>
                    </div>
                    <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-3 text-center">
                      <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">
                        {t('queue:statistics.delayed').toUpperCase()}
                      </div>
                      <div className="font-mono text-xl text-[#2B2B2B] dark:text-gray-100">
                        {cleanupPreview.byStatus.delayed}
                      </div>
                    </div>
                  </div>

                  {/* Jobs by User */}
                  {Object.keys(cleanupPreview.byUser).length > 0 && (
                    <div className="border-2 border-[#2B2B2B] dark:border-gray-200 p-4">
                      <h4 className="font-serif text-lg font-light text-[#2B2B2B] dark:text-gray-100 mb-3">
                        {t('queue:cleanup.preview.byUser')}
                      </h4>
                      <div className="space-y-2">
                        {Object.entries(cleanupPreview.byUser).map(([userId, data]) => (
                          <div
                            key={userId}
                            className="flex items-center justify-between py-2 border-b border-gray-200 dark:border-gray-700 last:border-0"
                          >
                            <span className="text-sm text-gray-700 dark:text-gray-300">{data.name}</span>
                            <span className="font-mono text-sm text-[#D2691E] dark:text-[#E87D3E]">
                              {t('queue:cleanup.preview.jobsCount', { count: data.count })}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Active Job Details */}
                  {cleanupPreview.activeJobs && cleanupPreview.activeJobs.length > 0 && (
                    <div className="border-2 border-dashed border-[#D2691E] dark:border-[#E87D3E] p-4">
                      <h4 className="font-serif text-lg font-light text-[#D2691E] dark:text-[#E87D3E] mb-3">
                        {t('queue:cleanup.preview.jobDetails')} ({t('queue:statistics.active')})
                      </h4>
                      <div className="space-y-3 max-h-60 overflow-y-auto">
                        {cleanupPreview.activeJobs.map((job) => (
                          <div
                            key={job.jobId}
                            className="border-l-2 border-[#D2691E] dark:border-[#E87D3E] pl-3 space-y-1 text-sm"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-gray-600 dark:text-gray-400">
                                {t('queue:cleanup.preview.user')}:
                              </span>
                              <span className="font-medium text-[#2B2B2B] dark:text-gray-100">
                                {job.user?.name || t('queue:cleanup.preview.noUserInfo')}
                              </span>
                            </div>
                            {job.assignment && (
                              <div className="flex items-start justify-between gap-2">
                                <span className="text-gray-600 dark:text-gray-400">
                                  {t('queue:cleanup.preview.assignment')}:
                                </span>
                                <span className="text-[#2B2B2B] dark:text-gray-100 text-right">
                                  {job.assignment.name}
                                </span>
                              </div>
                            )}
                            {job.file && (
                              <div className="flex items-start justify-between gap-2">
                                <span className="text-gray-600 dark:text-gray-400">
                                  {t('queue:cleanup.preview.file')}:
                                </span>
                                <span className="text-gray-700 dark:text-gray-300 text-right font-mono text-xs">
                                  {job.file.fileName}
                                </span>
                              </div>
                            )}
                            {job.addedAt && (
                              <div className="flex items-start justify-between gap-2">
                                <span className="text-gray-600 dark:text-gray-400">
                                  {t('queue:cleanup.preview.time')}:
                                </span>
                                <span className="text-gray-700 dark:text-gray-300 text-xs">
                                  {formatDateTimeInTimeZone(job.addedAt)}
                                </span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center py-8 text-gray-500 dark:text-gray-500">
                  {t('queue:cleanup.preview.noJobs')}
                </div>
              )}
            </div>

            {/* Dialog Footer */}
            <div className="sticky bottom-0 bg-background border-t-2 border-[#2B2B2B] dark:border-gray-200 p-6">
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => {
                    setShowCleanupDialog(false);
                    setCleanupPreview(null);
                  }}
                  disabled={cleanupLoading}
                  className="border-2 border-[#2B2B2B] dark:border-gray-200 px-6 py-2 font-serif transition-all hover:bg-[#2B2B2B] hover:text-white dark:hover:bg-gray-200 dark:hover:text-[#2B2B2B] disabled:opacity-30"
                >
                  {t('queue:cleanup.cancel')}
                </button>
                <button
                  onClick={handleCleanup}
                  disabled={cleanupLoading || loadingPreview}
                  className="border-2 border-[#D2691E] dark:border-[#E87D3E] bg-[#D2691E] dark:bg-[#E87D3E] text-white dark:text-[#2B2B2B] px-6 py-2 font-serif transition-all hover:bg-[#D2691E]/90 dark:hover:bg-[#E87D3E]/90 disabled:opacity-30 flex items-center gap-2"
                >
                  {cleanupLoading ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                      <span>{t('queue:cleanup.cleaning')}</span>
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                      <span>{t('queue:cleanup.cleanNow')}</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 401) {
    return <ErrorPage statusCode={401} messageKey="errors.generic.admin" returnTo="/" />;
  }

  return <ErrorPage statusCode="errors.generic.title" messageKey="errors.generic.message" returnTo="/" />;
}
