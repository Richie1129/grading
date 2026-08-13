/**
 * Overview Cards Component
 *
 * Display summary statistics in architectural sketch style cards
 */

import { TrendingUp, FileText, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface OverviewData {
  totalChatSessions: number;
  totalGradingSessions: number;
  totalTokensUsed: number;
}

export function OverviewCards({ data }: { data: OverviewData }) {
  const { t } = useTranslation('admin');

  const cards = [
    {
      title: t('analytics.overview.chatSessions.title'),
      value: data.totalChatSessions.toLocaleString(),
      icon: TrendingUp,
      description: t('analytics.overview.chatSessions.description'),
    },
    {
      title: t('analytics.overview.gradingSessions.title'),
      value: data.totalGradingSessions.toLocaleString(),
      icon: FileText,
      description: t('analytics.overview.gradingSessions.description'),
    },
    {
      title: t('analytics.overview.tokensUsed.title'),
      value: formatTokens(data.totalTokensUsed),
      icon: Zap,
      description: t('analytics.overview.tokensUsed.description'),
    },
  ];

  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card, index) => (
        <div
          key={index}
          className="group relative overflow-hidden rounded-sm border-2 border-[#2B2B2B] bg-card p-6 shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#D2691E]/60 hover:shadow-md dark:border-gray-200 dark:hover:border-[#E87D3E]/60"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#D2691E]/80 via-[#D2691E]/25 to-transparent dark:from-[#E87D3E]/80 dark:via-[#E87D3E]/25" />

          <div className="relative">
            {/* Icon */}
            <div className="mb-4 inline-flex rounded-md border border-[#D2691E]/25 bg-[#D2691E]/10 p-3 dark:border-[#E87D3E]/30 dark:bg-[#E87D3E]/10">
              <card.icon className="h-5 w-5 text-[#D2691E] dark:text-[#E87D3E]" strokeWidth={1.5} />
            </div>

            {/* Value */}
            <div className="mb-1 font-serif text-4xl font-light text-foreground">{card.value}</div>

            {/* Title */}
            <div className="mb-1 text-sm font-medium uppercase tracking-wide text-muted-foreground">{card.title}</div>

            {/* Description */}
            <div className="text-xs text-muted-foreground/90">{card.description}</div>

            {/* Organic accent line */}
            <svg className="absolute -right-4 -top-4 opacity-10" width="100" height="100" viewBox="0 0 100 100">
              <path d="M 10 50 Q 30 30, 50 50 T 90 50" stroke="#D2691E" strokeWidth="2" fill="none" />
            </svg>
          </div>
        </div>
      ))}
    </div>
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}
