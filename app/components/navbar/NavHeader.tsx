import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuGroup,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Share2, LogOut, User as UserIcon, Globe, Settings, Bell, MessageSquare, Menu, Moon, Sun } from 'lucide-react';
import { Link, useLoaderData, useLocation, useNavigate, NavLink } from 'react-router';
import * as React from 'react';
import { ModeToggle } from '@/components/ui/mode-toggle';
import { LanguageSwitcher } from '@/components/ui/LanguageSwitcher';
import { useTranslation } from 'react-i18next';
import { User } from '@/root';
import type { VersionInfo } from '@/services/version.server';
import { Badge } from '@/components/ui/badge';
import { useSubmissionStore } from '@/stores/submissionStore';
import { useChatHistoryStore } from '@/stores/chatHistoryStore';
import { NotificationCenter } from '@/components/teacher/NotificationCenter';
import { useUiStore } from '@/stores/uiStore';

interface NavigationTab {
  label: string;
  value: string;
  to: string;
  icon: React.ReactNode;
  end?: boolean;
}

interface NavHeaderProps {
  title?: string;
  onShare?: () => void;
  className?: string;
  tabs?: NavigationTab[];
}

export function NavHeader({ title, onShare, className, tabs }: NavHeaderProps) {
  // Always call hooks in the same order - before any early returns
  const { user, versionInfo } = useLoaderData() as { user: User | null; versionInfo: VersionInfo | null };

  // Use translation with error handling - always call this hook
  const { t, ready } = useTranslation('navigation', { useSuspense: false });

  // Get unread count for teachers only
  const unreadCount = useSubmissionStore((state) => state.unreadCount);
  const isTeacher = user?.role === 'TEACHER';

  // Chat history store and navigation
  const { setMobileHistoryOpen } = useChatHistoryStore();
  const location = useLocation();
  const navigate = useNavigate();
  const isOnAgentPlayground = location.pathname.startsWith('/agent-playground');

  // Theme and language store for mobile menu
  const { theme, setTheme, language, toggleLanguage } = useUiStore();

  // Early return after all hooks are called - root.tsx already handles conditional rendering
  if (!user) {
    return null;
  }

  // Fallback function for when i18n isn't ready
  const safeT = (key: string, fallback: string = key, options?: Record<string, unknown>) => {
    if (!ready || !t) {
      return fallback;
    }
    try {
      return t(key, { defaultValue: fallback, ...options });
    } catch (error) {
      console.warn(`Translation error for key "${key}":`, error);
      return fallback;
    }
  };

  const handleLogout = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        // 登出成功，重定向到首頁
        window.location.href = '/?logout=success';
      } else {
        console.error('Logout failed');
      }
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  return (
    <>
      <header className={cn(className)}>
        <nav className="relative w-full flex items-center justify-between py-3 px-4 sm:px-6 lg:px-8 ">
          {/* Left Section - Mobile: Chat history (agent-playground) or Logo */}
          <div className="flex items-center gap-3">
            {/* Mobile: Chat history button for agent-playground */}
            {isOnAgentPlayground && (
              <Button
                variant="ghost"
                size="sm"
                className="md:hidden px-2"
                onClick={() => setMobileHistoryOpen(true)}
                aria-label="Open chat history"
              >
                <Menu className="w-5 h-5" />
              </Button>
            )}

            {/* Logo & Title */}
            <Link to="/" className="flex items-center gap-3">
              <img src="/homepage.png" alt="Logo" className="w-10 h-10 object-contain" />
              <div className="hidden sm:block text-lg lg:text-xl 2xl:text-2xl font-semibold text-foreground">
                {title || safeT('title', 'Grading System')}
              </div>
            </Link>
          </div>

          {/* Center Section - Navigation Icons */}
          {tabs && tabs.length > 0 && (
            <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 sm:gap-3">
              {tabs.map((tab) => (
                <NavLink key={tab.value} to={tab.to} end={tab.end ?? true} prefetch="intent" title={tab.label}>
                  {({ isActive }) => (
                    <Button
                      variant="ghost"
                      size="icon-lg"
                      className={cn(
                        'group transition-all duration-300 lg:w-auto lg:px-3',
                        isActive
                          ? 'text-primary bg-primary/10 hover:bg-primary/15'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                      )}
                    >
                      <span className="shrink-0">{tab.icon}</span>
                      <span
                        className={cn(
                          'hidden lg:inline-block overflow-hidden whitespace-nowrap text-sm font-medium transition-all duration-300',
                          isActive ? 'max-w-[9rem] ml-2 opacity-100' : 'max-w-0 ml-0 opacity-0'
                        )}
                      >
                        {safeT('myNavLabel', `My ${tab.label}`, { label: tab.label })}
                      </span>
                    </Button>
                  )}
                </NavLink>
              ))}
            </div>
          )}

          {/* Center Section - Mobile Title (fallback when no tabs) */}
          {!tabs && (
            <div className="absolute left-1/2 -translate-x-1/2 sm:hidden">
              <div className="text-sm font-medium text-foreground/80 truncate max-w-32">
                {title || safeT('title', 'Grading System')}
              </div>
            </div>
          )}

          {/* Right Section - Desktop Controls */}
          <div className="hidden md:flex items-center gap-3 lg:gap-4 2xl:gap-5">
            <LanguageSwitcher />
            {onShare && (
              <Button variant="outline" size="sm" onClick={onShare} className="gap-2 lg:h-10 2xl:h-11 lg:px-4 2xl:px-5">
                <Share2 className="w-4 h-4 lg:w-5 lg:h-5" />
                <span className="lg:text-base">{safeT('share', 'Share')}</span>
              </Button>
            )}
            <ModeToggle />
            {isTeacher && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="relative lg:h-10 2xl:h-11">
                    <Bell className="w-4 h-4 lg:w-5 lg:h-5" />
                    {unreadCount > 0 && (
                      <Badge
                        variant="destructive"
                        className="absolute -top-1 -right-1 h-5 w-5 p-0 flex items-center justify-center text-xs"
                      >
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </Badge>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={8}
                  collisionPadding={12}
                  className="w-[clamp(18rem,92vw,36rem)] max-w-[calc(100vw-1rem)] p-0"
                >
                  <NotificationCenter />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-2 px-3 lg:h-10 2xl:h-11 lg:px-4 2xl:px-5">
                  {user.picture ? (
                    <img
                      src={user.picture}
                      alt={user.email}
                      className="w-6 h-6 lg:w-8 lg:h-8 2xl:w-10 2xl:h-10 rounded-full border-2 border-[#2B2B2B] dark:border-gray-200"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <UserIcon className="w-4 h-4 lg:w-5 lg:h-5 2xl:w-6 2xl:h-6" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={8}
                collisionPadding={12}
                className="w-[clamp(16rem,88vw,24rem)] max-w-[calc(100vw-1rem)] p-0"
              >
                {/* User Info - Centered like Google */}
                <div className="flex flex-col items-center gap-3 px-6 py-6">
                  {user.picture ? (
                    <img
                      src={user.picture}
                      alt={user.email}
                      className="w-20 h-20 rounded-full border-4 border-background shadow-sm"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center border-4 border-background shadow-sm">
                      <UserIcon className="w-10 h-10 text-muted-foreground" />
                    </div>
                  )}
                  <div className="text-center">
                    <p className="text-base font-medium leading-none">{user.email}</p>
                    <p className="text-sm text-muted-foreground mt-1.5">
                      {user.role === 'ADMIN'
                        ? safeT('administrator', 'Administrator')
                        : user.role === 'TEACHER'
                          ? safeT('teacher', 'Teacher')
                          : safeT('student', 'Student')}
                    </p>
                  </div>

                  {/* Primary CTA Button - Google style */}
                  <Button asChild variant="outline" className="w-full mt-2 rounded-full border-2 hover:bg-accent">
                    <Link to="/settings">{safeT('manageAccount', 'Manage Account')}</Link>
                  </Button>
                </div>

                {/* Secondary Actions - Google style cards */}
                <div className="px-4 pb-4 grid grid-cols-2 gap-3">
                  {user.role === 'ADMIN' && (
                    <Button
                      asChild
                      variant="secondary"
                      className="h-auto min-h-[4.75rem] py-3 px-4 flex flex-col items-center gap-2 rounded-xl"
                    >
                      <Link to="/admin">
                        <UserIcon className="w-5 h-5" />
                        <span className="text-xs">{safeT('adminCenter', 'Admin')}</span>
                      </Link>
                    </Button>
                  )}

                  <Button
                    variant="secondary"
                    className="h-auto min-h-[4.75rem] py-3 px-4 flex flex-col items-center gap-2 rounded-xl"
                    onClick={handleLogout}
                  >
                    <LogOut className="w-5 h-5" />
                    <span className="text-xs">{safeT('logout', 'Sign out')}</span>
                  </Button>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Right Section - Mobile: User Avatar Only */}
          <div className="flex md:hidden items-center gap-3">
            {isTeacher && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="relative px-2"
                    aria-label={safeT('notifications', 'Notifications')}
                  >
                    <Bell className="h-5 w-5" />
                    {unreadCount > 0 && (
                      <Badge
                        variant="destructive"
                        className="absolute -top-1 -right-1 h-5 w-5 p-0 flex items-center justify-center text-[10px]"
                      >
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </Badge>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={8}
                  collisionPadding={12}
                  className="w-[clamp(18rem,92vw,36rem)] max-w-[calc(100vw-1rem)] p-0"
                >
                  <NotificationCenter />
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* User Avatar with Dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="px-1">
                  {user.picture ? (
                    <img
                      src={user.picture}
                      alt={user.email}
                      className="w-8 h-8 rounded-full border-2 border-[#2B2B2B] dark:border-gray-200"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                      <UserIcon className="w-4 h-4 text-muted-foreground" />
                    </div>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={8}
                collisionPadding={12}
                className="w-[clamp(16rem,88vw,24rem)] max-w-[calc(100vw-1rem)] p-0"
              >
                {/* User Info - Centered like Google */}
                <div className="flex flex-col items-center gap-3 px-6 py-6">
                  {user.picture ? (
                    <img
                      src={user.picture}
                      alt={user.email}
                      className="w-20 h-20 rounded-full border-4 border-background shadow-sm"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center border-4 border-background shadow-sm">
                      <UserIcon className="w-10 h-10 text-muted-foreground" />
                    </div>
                  )}
                  <div className="text-center">
                    <p className="text-base font-medium leading-none">{user.email}</p>
                    <p className="text-sm text-muted-foreground mt-1.5">
                      {user.role === 'ADMIN'
                        ? safeT('administrator', 'Administrator')
                        : user.role === 'TEACHER'
                          ? safeT('teacher', 'Teacher')
                          : safeT('student', 'Student')}
                    </p>
                  </div>

                  {/* Primary CTA Button - Google style */}
                  <Button asChild variant="outline" className="w-full mt-2 rounded-full border-2 hover:bg-accent">
                    <Link to="/settings">{safeT('manageAccount', 'Manage Account')}</Link>
                  </Button>
                </div>

                {/* Quick Settings - Mobile Only */}
                <div className="px-4 pb-3 grid grid-cols-2 gap-3">
                  <Button
                    variant="secondary"
                    className="h-auto min-h-[4.75rem] py-3 px-4 flex flex-col items-center gap-2 rounded-xl"
                    onClick={(e) => {
                      e.preventDefault();
                      setTheme(theme === 'light' ? 'dark' : 'light');
                    }}
                  >
                    <div className="relative w-5 h-5 flex items-center justify-center">
                      <Sun className="absolute w-5 h-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
                      <Moon className="absolute w-5 h-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
                    </div>
                    <span className="text-xs">{safeT('theme', 'Theme')}</span>
                  </Button>

                  <Button
                    variant="secondary"
                    className="h-auto min-h-[4.75rem] py-3 px-4 flex flex-col items-center gap-2 rounded-xl"
                    onClick={(e) => {
                      e.preventDefault();
                      toggleLanguage();
                    }}
                  >
                    <Globe className="w-5 h-5" />
                    <span className="text-xs font-medium">{language === 'zh' ? '中文' : 'EN'}</span>
                  </Button>
                </div>

                {/* Secondary Actions - Google style cards */}
                <div className="px-4 pb-4 grid grid-cols-2 gap-3">
                  {user.role === 'ADMIN' && (
                    <Button
                      asChild
                      variant="secondary"
                      className="h-auto min-h-[4.75rem] py-3 px-4 flex flex-col items-center gap-2 rounded-xl"
                    >
                      <Link to="/admin">
                        <UserIcon className="w-5 h-5" />
                        <span className="text-xs">{safeT('adminCenter', 'Admin')}</span>
                      </Link>
                    </Button>
                  )}

                  <Button
                    variant="secondary"
                    className={cn(
                      'h-auto min-h-[4.75rem] py-3 px-4 flex flex-col items-center gap-2 rounded-xl',
                      user.role === 'ADMIN' ? '' : 'col-span-2'
                    )}
                    onClick={handleLogout}
                  >
                    <LogOut className="w-5 h-5" />
                    <span className="text-xs">{safeT('logout', 'Sign out')}</span>
                  </Button>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </nav>
      </header>
    </>
  );
}
