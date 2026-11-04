import { Moon, Sun } from "lucide-react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { useTheme } from "@/hooks/use-theme";
import { AgentsPage } from "@/pages/AgentsPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { RunsPage } from "@/pages/RunsPage";
import { TracePage } from "@/pages/TracePage";

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
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/traces/:runId" element={<TracePage />} />
            <Route path="/traces" element={<TracePage />} />
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
    </BrowserRouter>
  );
}
