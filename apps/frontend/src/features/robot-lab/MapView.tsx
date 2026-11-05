import { Bot, BrickWall, Package, QrCode } from "lucide-react";
import type { WarehouseMap, World } from "@mesa/shared/robot-lab";

export function MapView({ layout, world, trail = [], blocked = false }: {
  layout: WarehouseMap; world?: World; trail?: number[]; blocked?: boolean;
}) {
  const robot = world?.cell ?? layout.docks.A;
  const parcel = world?.parcel === "carried" ? robot : layout.docks[world?.parcel ?? "A"];
  const size = layout.scenario.size;
  return <div className="space-y-3">
    <div role="img" aria-label={`Warehouse ${size} by ${size}, robot at cell ${robot + 1}, parcel at cell ${parcel + 1}`}
      style={{ gridTemplateColumns: `repeat(${size},minmax(0,1fr))` }}
      className="grid w-full max-w-md gap-px overflow-hidden rounded-xl border bg-border">
      {Array.from({ length: size * size }, (_, cell) => {
        const dock = Object.entries(layout.docks).find(([, v]) => v === cell)?.[0];
        const wall = layout.obstacles.includes(cell);
        const sign = layout.signs.includes(cell);
        const color = wall ? "bg-muted" : blocked && cell === robot ? "bg-red-500/30" :
          trail.includes(cell) ? "bg-sky-500/20" : "bg-card";
        return <div key={cell} className={`relative flex aspect-square items-center justify-center ${color}`}>
          {dock && <strong className="absolute left-0.5 top-0 text-[10px] leading-none text-muted-foreground">{dock}</strong>}
          {wall && <BrickWall className="size-1/2 text-muted-foreground" />}
          {sign && <QrCode className="absolute right-0.5 top-0.5 size-1/3 text-violet-500" />}
          {cell === robot && <Bot className="size-1/2 text-sky-500" />}
          {cell === parcel && <Package className="absolute bottom-0.5 right-0.5 size-1/3 text-amber-600" />}
        </div>;
      })}
    </div>
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span><Bot className="inline size-4 text-sky-500" /> Robot</span>
      <span><Package className="inline size-4 text-amber-600" /> Parcel</span>
      <span><QrCode className="inline size-4 text-violet-500" /> QR</span>
      <span><BrickWall className="inline size-4" /> Obstacle</span>
    </div>
  </div>;
}
