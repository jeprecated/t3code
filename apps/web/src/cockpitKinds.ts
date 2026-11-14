import type { CockpitKind } from "@t3tools/client-runtime/state/cockpit-queue";
import {
  CircleAlertIcon,
  CirclePauseIcon,
  HandIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  ScanEyeIcon,
  ShieldQuestionIcon,
  SignpostIcon,
  SquareIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";

/** Icons and colours match the sidebar's thread statuses where a kind has one. */
export const COCKPIT_KINDS: Record<
  CockpitKind,
  {
    readonly label: string;
    readonly icon: LucideIcon;
    readonly className: string;
    /** The kind's colour as a fill, for the progress strip. */
    readonly barClassName: string;
  }
> = {
  approval: {
    label: "Approval",
    icon: ShieldQuestionIcon,
    className: "text-warning-foreground",
    barClassName: "bg-warning",
  },
  question: {
    label: "Question",
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
    barClassName: "bg-indigo-500",
  },
  request: {
    label: "Request",
    icon: UserRoundIcon,
    className: "text-guest-foreground",
    barClassName: "bg-guest",
  },
  decision: {
    label: "Decision",
    icon: SignpostIcon,
    className: "text-indigo-600 dark:text-indigo-300",
    barClassName: "bg-indigo-500",
  },
  manual_step: {
    label: "Manual step",
    icon: HandIcon,
    className: "text-warning-foreground",
    barClassName: "bg-warning",
  },
  blocked: {
    label: "Blocked",
    icon: CirclePauseIcon,
    className: "text-muted-foreground",
    barClassName: "bg-muted-foreground",
  },
  plan: {
    label: "Plan",
    icon: ListChecksIcon,
    className: "text-info-foreground",
    barClassName: "bg-info",
  },
  review: {
    label: "Review",
    icon: ScanEyeIcon,
    className: "text-success-foreground",
    barClassName: "bg-success",
  },
  fix: {
    label: "Fix",
    icon: CircleAlertIcon,
    className: "text-destructive-foreground",
    barClassName: "bg-destructive",
  },
  todo: {
    label: "Todo",
    icon: SquareIcon,
    className: "text-muted-foreground",
    barClassName: "bg-muted-foreground",
  },
};
