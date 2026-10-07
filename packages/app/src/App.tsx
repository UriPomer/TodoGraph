import { lazy, Suspense, useEffect } from 'react';
import { LoginPage } from '@/features/auth/LoginPage';
import { useAuth } from '@/features/auth/useAuth';
import { ThemeProvider } from '@/features/theme/ThemeProvider';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

const WorkspaceApp = lazy(() => import('@/features/workspace/WorkspaceApp'));

function LoadingState() {
  return <div className="flex h-full flex-1 items-center justify-center text-sm text-muted-foreground">加载中...</div>;
}

function AppContent() {
  const { user, loading, login, register, logout, startLocal, error } = useAuth();
  const resetSession = useWorkspaceStore((state) => state.resetSession);
  const workspaceUserId = useWorkspaceStore((state) => state.sessionUserId);
  useEffect(() => {
    if (!loading && !user && workspaceUserId !== null) resetSession();
  }, [loading, resetSession, user, workspaceUserId]);
  if (loading) return <LoadingState />;
  if (!user) return <><LoginPage onLogin={login} onRegister={register} onLocal={startLocal} />{error && <p role="alert" className="fixed bottom-4 left-4 right-4 text-center text-sm text-destructive">{error}</p>}</>;
  return <Suspense fallback={<LoadingState />}><WorkspaceApp user={user} logout={logout} /></Suspense>;
}

export default function App() {
  return <ThemeProvider><AppContent /></ThemeProvider>;
}
