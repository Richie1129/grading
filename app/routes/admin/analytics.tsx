/**
 * Admin Analytics Dashboard
 *
 * Architectural sketch style dashboard for monitoring agent chats and grading sessions
 */

import { useRouteError, isRouteErrorResponse, useLoaderData } from 'react-router';
import type { LoaderFunctionArgs } from 'react-router';
import { getUserId } from '@/services/auth.server';
import { db } from '@/lib/db.server';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OverviewCards } from '@/components/admin/analytics/OverviewCards';
import { ErrorPage } from '@/components/errors/ErrorPage';
import { ChatSessionsTab } from '@/components/admin/analytics/ChatSessionsTab';
import { GradingSessionsTab } from '@/components/admin/analytics/GradingSessionsTab';

export async function loader({ request }: LoaderFunctionArgs) {
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

  // Fetch initial overview data
  const [totalChatSessions, totalGradingSessions, chatTokenStats, gradingTokenStats] = await Promise.all([
    db.agentChatSession.count(),
    db.gradingResult.count({ where: { status: 'COMPLETED' } }),
    db.agentChatSession.aggregate({ _sum: { totalTokens: true } }),
    db.gradingResult.aggregate({ _sum: { gradingTokens: true, sparringTokens: true } }), // Include sparring tokens
  ]);

  const overview = {
    totalChatSessions,
    totalGradingSessions,
    totalTokensUsed:
      (chatTokenStats._sum.totalTokens || 0) +
      (gradingTokenStats._sum.gradingTokens || 0) +
      (gradingTokenStats._sum.sparringTokens || 0), // Sum sparring tokens
  };

  return { user, overview };
}

export default function AdminAnalytics() {
  const { user, overview } = useLoaderData<typeof loader>();
  const { t } = useTranslation('admin');
  const [activeTab, setActiveTab] = useState<'chats' | 'gradings'>('gradings');

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/20">
      {/* Header */}
      <header className="border-b-2 border-[#2B2B2B] backdrop-blur-sm dark:border-gray-200">
        <div className="mx-auto max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.24em] text-[#D2691E] dark:text-[#E87D3E]">
                {t('analytics.eyebrow')}
              </p>
              <h1 className="font-serif text-3xl font-light tracking-tight text-[#2B2B2B] dark:text-gray-100">
                {t('analytics.title')}
              </h1>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('analytics.subtitle')}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{user.name}</p>
              <p className="text-xs text-gray-500 dark:text-gray-500">{user.email}</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[96rem] px-4 py-8 sm:px-6 lg:px-8">
        {/* Overview Cards */}
        <OverviewCards data={overview} />

        {/* Tab Navigation - Architectural Sketch Style */}
        <div className="mt-12">
          <div className="relative">
            <div className="inline-flex gap-2 rounded-sm border-2 border-[#2B2B2B] bg-card p-2 dark:border-gray-200">
              <button
                onClick={() => setActiveTab('gradings')}
                className={`
                  rounded-sm px-5 py-2.5 font-serif text-base transition-all
                  ${
                    activeTab === 'gradings'
                      ? 'border border-[#D2691E]/40 bg-[#D2691E]/10 text-[#D2691E] dark:border-[#E87D3E]/40 dark:bg-[#E87D3E]/15 dark:text-[#E87D3E]'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }
                `}
              >
                {t('analytics.tabs.grading')}
              </button>
              <button
                onClick={() => setActiveTab('chats')}
                className={`
                  rounded-sm px-5 py-2.5 font-serif text-base transition-all
                  ${
                    activeTab === 'chats'
                      ? 'border border-[#D2691E]/40 bg-[#D2691E]/10 text-[#D2691E] dark:border-[#E87D3E]/40 dark:bg-[#E87D3E]/15 dark:text-[#E87D3E]'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }
                `}
              >
                {t('analytics.tabs.chat')}
              </button>
            </div>
          </div>

          {/* Tab Content */}
          <div className="mt-8">
            {activeTab === 'chats' && <ChatSessionsTab />}
            {activeTab === 'gradings' && <GradingSessionsTab />}
          </div>
        </div>
      </main>
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
