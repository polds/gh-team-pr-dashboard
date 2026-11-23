import { useState } from "react";
import type { ReactNode } from "react";
import type { Person } from "@radar/core";

export function Avatar({ person, size = 20, alt, children }: { person: Pick<Person, "login" | "avatarUrl">; size?: number; alt?: string; children?: ReactNode }) {
	const [failed, setFailed] = useState(false);
	const label = alt ?? person.login;
	return (
		<span className="avatar" style={{ width: size, height: size }} title={label}>
			{failed || person.avatarUrl === "" ? (
				<span className="avatar-fallback" role="img" aria-label={label} style={{ fontSize: Math.max(9, size * 0.42) }}>
					{person.login.slice(0, 2).toUpperCase()}
				</span>
			) : (
				<img src={person.avatarUrl} alt={label} width={size} height={size} decoding="async" onError={() => setFailed(true)} />
			)}
			{children}
		</span>
	);
}

export function AvatarStack({ people, max = 4, size = 20, label }: { people: readonly Person[]; max?: number; size?: number; label: string }) {
	if (people.length === 0) return null;
	const shown = people.slice(0, max);
	const rest = people.length - shown.length;
	return (
		<span className="avatar-stack" role="group" aria-label={label}>
			{shown.map((person) => (
				<Avatar key={person.login} person={person} size={size} />
			))}
			{rest > 0 && (
				<span className="avatar-more" title={people.slice(max).map((p) => p.login).join(", ")}>
					+{rest}
				</span>
			)}
		</span>
	);
}
