// Import all existing locale files
import enCommon from '../locales/en/common.json';
import enAuth from '../locales/en/auth.json';
import enDashboard from '../locales/en/dashboard.json';
import enRubric from '../locales/en/rubric.json';
import enGrading from '../locales/en/grading.json';
import enCourse from '../locales/en/course.json';
import enNavigation from '../locales/en/navigation.json';
import enLanding from '../locales/en/landing.json';
import enSubmissions from '../locales/en/submissions.json';
import enAssignment from '../locales/en/assignment.json';
import enErrors from '../locales/en/errors.json';
import enTeacher from '../locales/en/teacher.json';
import enSettings from '../locales/en/settings.json';
import enAnalytics from '../locales/en/analytics.json';
import enAgent from '../locales/en/agent.json';
import enQueue from '../locales/en/queue.json';
import enAdmin from '../locales/en/admin.json';

import zhCommon from '../locales/zh/common.json';
import zhAuth from '../locales/zh/auth.json';
import zhDashboard from '../locales/zh/dashboard.json';
import zhRubric from '../locales/zh/rubric.json';
import zhGrading from '../locales/zh/grading.json';
import zhCourse from '../locales/zh/course.json';
import zhNavigation from '../locales/zh/navigation.json';
import zhLanding from '../locales/zh/landing.json';
import zhSubmissions from '../locales/zh/submissions.json';
import zhAssignment from '../locales/zh/assignment.json';
import zhErrors from '../locales/zh/errors.json';
import zhTeacher from '../locales/zh/teacher.json';
import zhSettings from '../locales/zh/settings.json';
import zhAnalytics from '../locales/zh/analytics.json';
import zhAgent from '../locales/zh/agent.json';
import zhQueue from '../locales/zh/queue.json';
import zhAdmin from '../locales/zh/admin.json';

// Create supported languages array
export const supportedLanguages = ['en', 'zh'];
export type SupportedLanguage = (typeof supportedLanguages)[number];

// Define resource structure
export type Resource = {
  common: typeof enCommon;
  auth: typeof enAuth;
  dashboard: typeof enDashboard;
  rubric: typeof enRubric;
  grading: typeof enGrading;
  course: typeof enCourse;
  navigation: typeof enNavigation;
  landing: typeof enLanding;
  submissions: typeof enSubmissions;
  assignment: typeof enAssignment;
  errors: typeof enErrors;
  teacher: typeof enTeacher;
  settings: typeof enSettings;
  analytics: typeof enAnalytics;
  agent: typeof enAgent;
  queue: typeof enQueue;
  admin: typeof enAdmin;
};

// Export resources in the format remix-i18next expects
export const resources: Record<SupportedLanguage, Resource> = {
  en: {
    common: enCommon,
    auth: enAuth,
    dashboard: enDashboard,
    rubric: enRubric,
    grading: enGrading,
    course: enCourse,
    navigation: enNavigation,
    landing: enLanding,
    submissions: enSubmissions,
    assignment: enAssignment,
    errors: enErrors,
    teacher: enTeacher,
    settings: enSettings,
    analytics: enAnalytics,
    agent: enAgent,
    queue: enQueue,
    admin: enAdmin,
  },
  zh: {
    common: zhCommon,
    auth: zhAuth,
    dashboard: zhDashboard,
    rubric: zhRubric,
    grading: zhGrading,
    course: zhCourse,
    navigation: zhNavigation,
    landing: zhLanding,
    submissions: zhSubmissions,
    assignment: zhAssignment,
    errors: zhErrors,
    teacher: zhTeacher,
    settings: zhSettings,
    analytics: zhAnalytics,
    agent: zhAgent,
    queue: zhQueue,
    admin: zhAdmin,
  },
};
