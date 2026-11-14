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
  }
> = {
  approval: {
    label: "Approval",
    icon: ShieldQuestionIcon,
    className: "text-warning-foreground",
  },
  question: {
    label: "Question",
    icon: MessageCircleQuestionIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  request: {
    label: "Request",
    icon: UserRoundIcon,
    className: "text-guest-foreground",
  },
  decision: {
    label: "Decision",
    icon: SignpostIcon,
    className: "text-indigo-600 dark:text-indigo-300",
  },
  manual_step: {
    label: "Manual step",
    icon: HandIcon,
    className: "text-warning-foreground",
  },
  blocked: {
    label: "Blocked",
    icon: CirclePauseIcon,
    className: "text-muted-foreground",
  },
  plan: {
    label: "Plan",
    icon: ListChecksIcon,
    className: "text-info-foreground",
  },
  review: {
    label: "Review",
    icon: ScanEyeIcon,
    className: "text-success-foreground",
  },
  fix: {
    label: "Fix",
    icon: CircleAlertIcon,
    className: "text-destructive-foreground",
  },
  todo: {
    label: "Todo",
    icon: SquareIcon,
    className: "text-muted-foreground",
  },
};
