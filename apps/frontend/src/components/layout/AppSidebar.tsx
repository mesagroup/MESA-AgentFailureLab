import { Activity, Bot, LayoutDashboard, Play, Zap } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
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

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/agents", label: "Agents", icon: Bot, exact: false },
  { to: "/runs", label: "Runs", icon: Play, exact: false },
  { to: "/traces", label: "Traces", icon: Activity, exact: false },
];

export function AppSidebar() {
  const { pathname } = useLocation();

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
              {NAV.map(({ to, label, icon: Icon, exact }) => {
                const isActive = exact ? pathname === to : pathname.startsWith(to);
                return (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton
                      tooltip={label}
                      isActive={isActive}
                      render={<Link to={to} />}
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
