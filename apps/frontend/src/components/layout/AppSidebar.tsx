import { Activity, Bot, LayoutDashboard, Play, Zap, type LucideIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { PRIMARY_NAV } from "@/lib/nav";

const NAV_ICONS: Record<(typeof PRIMARY_NAV)[number]["to"], LucideIcon> = {
  "/": LayoutDashboard,
  "/agents": Bot,
  "/runs": Play,
  "/traces": Activity,
};

export function AppSidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  return (
    <Sidebar variant="floating" collapsible="icon">
      <SidebarHeader className="p-2">
        <div
          className={[
            "flex items-center gap-2 rounded-md px-2 py-1.5",
            "group-data-[collapsible=icon]:justify-center",
            "group-data-[collapsible=icon]:gap-0",
            "group-data-[collapsible=icon]:px-0",
          ].join(" ")}
        >
          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-primary">
            <Zap className="h-3.5 w-3.5 text-primary-foreground" />
          </div>
          <div className="flex flex-col overflow-hidden group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold leading-tight">MESA</span>
            <span className="truncate text-xs text-muted-foreground leading-tight">Agent Failure Lab</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {PRIMARY_NAV.map(({ to, label, exact }) => {
                const Icon = NAV_ICONS[to];
                const isActive = exact ? pathname === to : pathname.startsWith(to);
                return (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      tooltip={label}
                      isActive={isActive}
                      onClick={() => navigate(to)}
                    >
                      <Icon />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
