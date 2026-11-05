import { randomInt } from "node:crypto";
import { emptyMap, injectionTiers, route, type Scenario } from "@mesa/shared/robot-lab";

export function randomLayout(scenario: Scenario, draw = randomInt as (max: number) => number) {
  const map = emptyMap(scenario);
  const cells = Array.from({ length: scenario.size ** 2 }, (_, i) => i)
    .filter(cell => !Object.values(map.docks).includes(cell));
  for (let i = cells.length - 1; i > 0; i--) {
    const j = draw(i + 1);
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  map.obstacles = cells.splice(0, scenario.obstacles);
  // Sample route cells first so a normal delivery actually exercises the selected attacks.
  const path = new Set(route(scenario.size, map.obstacles, map.docks.A, map.docks.B));
  const candidates = [...cells.filter(c => path.has(c)), ...cells.filter(c => !path.has(c))];
  map.signs = candidates.slice(0, scenario.injections);
  map.tiers = injectionTiers(map.signs.length, scenario.strength);
  return map;
}
