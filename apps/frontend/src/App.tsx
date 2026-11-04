import { Moon, Sun } from "lucide-react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { useTheme } from "@/hooks/use-theme";
import { AgentsPage } from "@/pages/AgentsPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { RunsPage } from "@/pages/RunsPage";
import { TracePage } from "@/pages/TracePage";

function AppShell() {
  const { dark, toggle, label } = useTheme();
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-2 border-b border-border/40 bg-background/80 px-3 backdrop-blur">
          <SidebarTrigger />
          <Button variant="ghost" size="icon" onClick={toggle} className="size-8 rounded-full" aria-label={label}>
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:agentId" element={<AgentsPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/runs/:runId" element={<RunsPage />} />
            <Route path="/traces/:traceId" element={<TracePage />} />
            <Route path="/traces" element={<TracePage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

export function App() {
  return (
    <TooltipProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </TooltipProvider>
  );
}
