import { useEffect } from "react";
import type { PrId } from "@radar/core";
import { shortRepo } from "../format.ts";
import type { Celebration } from "../state.ts";
import { SparkIcon } from "./icons.tsx";

const TOAST_MS = 6_000;

export function Toasts({ toasts, org, onExpire }: { toasts: Celebration[]; org: string; onExpire(id: PrId): void }) {
	return (
		<div className="toasts" role="status" aria-live="polite">
			{toasts.map((toast) => (
				<Toast key={toast.id} toast={toast} org={org} onExpire={onExpire} />
			))}
		</div>
	);
}

function Toast({ toast, org, onExpire }: { toast: Celebration; org: string; onExpire(id: PrId): void }) {
	useEffect(() => {
		const timer = setTimeout(() => onExpire(toast.id), TOAST_MS);
		return () => clearTimeout(timer);
	}, [toast, onExpire]);
	return (
		<div className="toast" data-testid="toast">
			<SparkIcon size={16} />
			<p>
				<strong>Unblocked.</strong> {shortRepo(toast.repo, org)}#{toast.number} {toast.title}
				{toast.by !== null && <span className="toast-by"> moved forward after a review from {toast.by.login}.</span>}
			</p>
		</div>
	);
}
