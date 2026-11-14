import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironments } from "../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

const ANY_MACHINE = "any";

/** Offers connected machines, plus the saved one so an offline pin still reads correctly. */
export function NewThreadPresetMachineSelect({
  id,
  label,
  value,
  onValueChange,
}: {
  id?: string;
  label: string;
  value: EnvironmentId | undefined;
  onValueChange: (environmentId: EnvironmentId | undefined) => void;
}) {
  const { environments } = useEnvironments();
  const machines = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" || environment.environmentId === value,
  );
  const labelOf = (selected: string | null) =>
    selected === null || selected === ANY_MACHINE
      ? "Any machine"
      : (machines.find((machine) => machine.environmentId === selected)?.label ??
        "Unknown machine");
  return (
    <Select
      value={value ?? ANY_MACHINE}
      onValueChange={(selected) =>
        onValueChange(machines.find((machine) => machine.environmentId === selected)?.environmentId)
      }
    >
      <SelectTrigger id={id} size="sm" aria-label={label}>
        <SelectValue>{labelOf}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem value={ANY_MACHINE}>Any machine</SelectItem>
        {machines.map((machine) => (
          <SelectItem key={machine.environmentId} value={machine.environmentId}>
            {machine.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
