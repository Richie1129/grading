/**
 * Admin Hub Page
 *
 * Architectural sketch style central navigation for admin functions
 */

import type { LoaderFunctionArgs } from 'react-router';
import { Link, useLoaderData, useRouteError, isRouteErrorResponse } from 'react-router';
import { getUserId } from '@/services/auth.server';
import { db } from '@/lib/db.server';
import { Users, BarChart3, Activity, Home } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await getUserId(request);
  if (!userId) {
    throw new Response('Unauthorized', { status: 401 });
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, name: true },
  });

  if (user?.role !== 'ADMIN') {
    throw new Response('Forbidden: Admin access required', { status: 403 });
  }

  return { user };
}

export default function AdminHub() {
  const { user } = useLoaderData<typeof loader>();
  const { t } = useTranslation('admin');

  const adminFeatures = [
    {
      title: t('hub.features.users.title'),
      description: t('hub.features.users.description'),
      href: '/admin/users',
      icon: Users,
    },
    {
      title: t('hub.features.analytics.title'),
      description: t('hub.features.analytics.description'),
      href: '/admin/analytics',
      icon: BarChart3,
    },
    {
      title: t('hub.features.queues.title'),
      description: t('hub.features.queues.description'),
      href: '/admin/queues',
      icon: Activity,
    },
  ];

  return (
    <div className="min-h-screen">
      {/* Header - Architectural Sketch Style */}
      <header className="border-b-2 border-[#2B2B2B] dark:border-gray-200">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div>
            <h1 className="font-serif text-3xl font-light tracking-tight text-[#2B2B2B] dark:text-gray-100">
              {t('hub.title')}
            </h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('hub.welcome', { name: user.name })}</p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        {/* Section Header */}
        <div className="mb-10">
          <h2 className="font-serif text-xl font-light text-[#2B2B2B] dark:text-gray-100">{t('hub.sectionTitle')}</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('hub.sectionSubtitle')}</p>
        </div>

        {/* Feature Grid - Hand-drawn Cards */}
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {adminFeatures.map((feature) => (
            <Link key={feature.href} to={feature.href} className="group relative block">
              {/* Sketch-style Card Container */}
              <div className="relative border-2 border-[#2B2B2B] p-8 transition-all hover:border-[#D2691E] dark:border-gray-200 dark:hover:border-[#E87D3E]">
                {/* Icon - Minimal sketch style */}
                <div className="mb-6 inline-flex border-2 border-[#2B2B2B] p-3 transition-colors group-hover:border-[#D2691E] group-hover:bg-[#D2691E]/5 dark:border-gray-200 dark:group-hover:border-[#E87D3E] dark:group-hover:bg-[#E87D3E]/10">
                  <feature.icon
                    className="h-7 w-7 text-[#2B2B2B] transition-colors group-hover:text-[#D2691E] dark:text-gray-200 dark:group-hover:text-[#E87D3E]"
                    strokeWidth={1.5}
                  />
                </div>

                {/* Title */}
                <h3 className="mb-3 font-serif text-lg font-light text-[#2B2B2B] transition-colors group-hover:text-[#D2691E] dark:text-gray-100 dark:group-hover:text-[#E87D3E]">
                  {feature.title}
                </h3>

                {/* Description */}
                <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">{feature.description}</p>

                {/* Accent line on hover - Terracotta */}
                <div className="absolute bottom-0 left-0 h-1 w-full origin-left scale-x-0 bg-[#D2691E] transition-transform duration-300 group-hover:scale-x-100 dark:bg-[#E87D3E]" />
              </div>

              {/* Organic connecting curve (decorative) */}
              <svg
                className="pointer-events-none absolute -right-4 top-1/2 hidden -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-30 lg:block"
                width="20"
                height="60"
                viewBox="0 0 20 60"
                fill="none"
              >
                <path
                  d="M2 30 Q10 15, 18 30 T18 45"
                  stroke="#D2691E"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  className="dark:stroke-[#E87D3E]"
                />
              </svg>
            </Link>
          ))}
        </div>

        {/* Bottom decorative element - Abstract sketch */}
        <div className="mt-16 flex justify-center opacity-20 dark:opacity-30">
          <svg width="200" height="40" viewBox="0 0 200 40" fill="none">
            <path
              d="M10 20 Q50 5, 100 20 T190 20"
              stroke="#2B2B2B"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
              className="dark:stroke-gray-200"
            />
          </svg>
        </div>
      </main>
    </div>
  );
}

// Error Boundary for handling loader errors
export function ErrorBoundary() {
  const error = useRouteError();
  const { t } = useTranslation('admin');

  if (isRouteErrorResponse(error) && (error.status === 401 || error.status === 403)) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center px-4">
        <div className="space-y-6 text-center">
          <div className="space-y-3">
            <h1 className="font-serif text-4xl font-light text-[#2B2B2B] dark:text-gray-100">{error.status}</h1>
            <p className="text-gray-600 dark:text-gray-400">{t('errors.forbidden')}</p>
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-2 border border-[#2B2B2B] px-6 py-3 text-sm transition-colors hover:bg-[#2B2B2B] hover:text-white dark:border-gray-200 dark:hover:bg-gray-200 dark:hover:text-[#2B2B2B]"
          >
            <Home className="h-4 w-4" />
            {t('errors.backHome')}
          </Link>
        </div>
      </div>
    );
  }

  // Handle other errors
  return (
    <div className="flex min-h-screen w-full items-center justify-center px-4">
      <div className="space-y-6 text-center">
        <div className="space-y-3">
          <h1 className="font-serif text-4xl font-light text-[#2B2B2B] dark:text-gray-100">
            {t('errors.genericTitle')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400">{t('errors.loadFailed')}</p>
        </div>
        <Link
          to="/"
          className="inline-flex items-center gap-2 border border-[#2B2B2B] px-6 py-3 text-sm transition-colors hover:bg-[#2B2B2B] hover:text-white dark:border-gray-200 dark:hover:bg-gray-200 dark:hover:text-[#2B2B2B]"
        >
          <Home className="h-4 w-4" />
          {t('errors.backHome')}
        </Link>
      </div>
    </div>
  );
}
