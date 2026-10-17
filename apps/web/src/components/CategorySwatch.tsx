import type { ProjectIconColor } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { PROJECT_ICON_COLORS } from "../projectIconColors";

export const CATEGORY_SWATCH_CLASS_BY_COLOR: ReadonlyMap<string, string> = new Map(
  PROJECT_ICON_COLORS.map((color) => [color.value, color.swatchClassName]),
);

/** A `null` color is the dashed swatch for threads in no category. */
export function CategorySwatch(props: { color: ProjectIconColor | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0 rounded-sm",
        props.color === null
          ? "border border-dashed border-current"
          : CATEGORY_SWATCH_CLASS_BY_COLOR.get(props.color),
        props.className,
      )}
    />
  );
}
