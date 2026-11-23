import type { ReactNode } from "react";
import type { ReviewerStatusKind } from "@radar/core";

function Icon({ size = 16, children, label }: { size?: number; children: ReactNode; label?: string }) {
	return (
		<svg
			className="icon"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			role={label === undefined ? undefined : "img"}
			aria-hidden={label === undefined ? true : undefined}
			aria-label={label}
		>
			{children}
		</svg>
	);
}

type IconProps = { size?: number; label?: string };

export const CheckIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M3.5 8.5l3 3 6-7" />
	</Icon>
);

export const CrossIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
	</Icon>
);

export const PendingIcon = (p: IconProps) => (
	<Icon {...p}>
		<circle cx="8" cy="8" r="5.5" strokeDasharray="2.2 2.2" />
		<circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
	</Icon>
);

export const DashIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M4.5 8h7" />
	</Icon>
);

export const ClockIcon = (p: IconProps) => (
	<Icon {...p}>
		<circle cx="8" cy="8" r="5.8" />
		<path d="M8 4.8V8l2.2 1.4" />
	</Icon>
);

export const BellIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M4 11.5V7.5a4 4 0 018 0v4l1 1H3l1-1z" />
		<path d="M6.8 14h2.4" />
	</Icon>
);

export const BellOffIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M5.2 4.3A4 4 0 0112 7.5v3M4 7.5v4l-1 1h8.5" />
		<path d="M6.8 14h2.4M2.5 2.5l11 11" />
	</Icon>
);

export const ChevronRightIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M6.5 4l4 4-4 4" />
	</Icon>
);

export const ExternalIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M9.5 3.5h3v3M12.5 3.5L7.5 8.5M11 9.5v3h-7.5v-7.5h3" />
	</Icon>
);

export const EyeIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8z" />
		<circle cx="8" cy="8" r="1.8" />
	</Icon>
);

export const FlagIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M4 14V2.8M4 3h7.5l-1.6 2.7L11.5 8.4H4" />
	</Icon>
);

export const SearchIcon = (p: IconProps) => (
	<Icon {...p}>
		<circle cx="7" cy="7" r="4.2" />
		<path d="M10.2 10.2l3.3 3.3" />
	</Icon>
);

export const SparkIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l1.8 1.8M10 10l1.8 1.8M4.2 11.8L6 10M10 6l1.8-1.8" />
	</Icon>
);

export const MergedIcon = (p: IconProps) => (
	<Icon {...p}>
		<circle cx="4.5" cy="3.5" r="1.5" />
		<circle cx="4.5" cy="12.5" r="1.5" />
		<circle cx="11.5" cy="8.5" r="1.5" />
		<path d="M4.5 5v6M4.5 5.5c0 2 2 3 5.5 3" />
	</Icon>
);

export const ClosedIcon = (p: IconProps) => (
	<Icon {...p}>
		<circle cx="8" cy="8" r="5.8" />
		<path d="M5.8 5.8l4.4 4.4" />
	</Icon>
);

export const RadarMark = ({ size = 22 }: { size?: number }) => (
	<svg className="radar-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
		<circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" opacity="0.35" />
		<circle cx="12" cy="12" r="6" stroke="currentColor" strokeWidth="1.6" opacity="0.6" />
		<path d="M12 12L19.5 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		<circle cx="12" cy="12" r="2" fill="currentColor" />
	</svg>
);

/** One small mark per reviewer status, drawn in the corner of the reviewer's avatar. */
export function ReviewerMark({ kind }: { kind: ReviewerStatusKind }) {
	switch (kind) {
		case "approved":
			return (
				<Icon size={10}>
					<path d="M3.5 8.5l3 3 6-7" strokeWidth="2.6" />
				</Icon>
			);
		case "feedback_outstanding":
			return (
				<Icon size={10}>
					<path d="M3 4h10v6H8l-3 2.5V10H3z" strokeWidth="2" />
				</Icon>
			);
		case "feedback_addressed":
			return (
				<Icon size={10}>
					<path d="M12.5 6.5A4.5 4.5 0 004 6M3.5 9.5A4.5 4.5 0 0012 10M4 2.5V6h3.5M12 13.5V10H8.5" strokeWidth="2" />
				</Icon>
			);
		case "approval_dismissed":
			return (
				<Icon size={10}>
					<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" strokeWidth="2.4" />
				</Icon>
			);
		case "commented":
			return (
				<Icon size={10}>
					<path d="M3 4h10v6H8l-3 2.5V10H3z" strokeWidth="2" />
				</Icon>
			);
		case "requested":
			return (
				<Icon size={10}>
					<circle cx="8" cy="8" r="3.5" fill="currentColor" stroke="none" />
				</Icon>
			);
		default: {
			const _exhaustive: never = kind;
			return null;
		}
	}
}
