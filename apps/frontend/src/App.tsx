import { Moon, Sun } from "lucide-react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { useTheme } from "@/hooks/use-theme";
import { AgentsPage } from "@/pages/AgentsPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { RUNS_DETAIL_ROUTE, RUNS_LIST_ROUTE } from "@/lib/run-detail";
import { JURY_LEGACY_PATH, juryLegacyRedirectTo } from "@/lib/security-runs";
import { RunDetailPage } from "@/pages/RunDetailPage";
import { RunsPage } from "@/pages/RunsPage";
import { EvalScoreboardPage } from "@/pages/EvalScoreboardPage";
import { TracePage } from "@/pages/TracePage";
import { TracesIndexPage } from "@/pages/TracesIndexPage";

function AppShell() {
  const { dark, toggle } = useTheme();
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 items-center justify-between gap-2 px-3 sticky top-0 z-10 pointer-events-none">
          <div className="pointer-events-auto">
            <SidebarTrigger />
          </div>
          <div className="pointer-events-auto">
            <Button variant="ghost" size="icon" onClick={toggle} className="h-8 w-8 rounded-full">
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </div>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path={JURY_LEGACY_PATH} element={<Navigate to={juryLegacyRedirectTo()} replace />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path={RUNS_LIST_ROUTE} element={<RunsPage />} />
            <Route path={RUNS_DETAIL_ROUTE} element={<RunDetailPage />} />
            <Route path="/traces/:traceId" element={<TracePage />} />
            <Route path="/traces" element={<TracesIndexPage />} />
            <Route path="/eval" element={<EvalScoreboardPage />} />
          </Routes>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppShell />
      <Toaster position="bottom-right" richColors />
    </BrowserRouter>
  );
}
