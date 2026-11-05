export const PRIMARY_NAV = [
  { to: "/", label: "Dashboard", exact: true },
  { to: "/agents", label: "Agents", exact: false },
  { to: "/runs", label: "Runs", exact: false },
  { to: "/traces", label: "Traces", exact: false },
] as const;
