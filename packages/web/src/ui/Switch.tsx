export function Switch({
	checked,
	onChange,
	label,
	testId,
	disabled = false,
	describedBy,
}: {
	checked: boolean;
	onChange(checked: boolean): void;
	label: string;
	testId?: string;
	disabled?: boolean;
	describedBy?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			className="switch"
			aria-checked={checked}
			aria-describedby={describedBy}
			data-testid={testId}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			<span className="switch-track" aria-hidden="true">
				<span className="switch-knob" />
			</span>
			<span className="switch-label">{label}</span>
		</button>
	);
}
