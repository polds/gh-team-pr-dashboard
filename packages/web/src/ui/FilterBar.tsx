import type { Viewer } from "@radar/core";
import { NO_FILTERS, isFiltering } from "../filters.ts";
import { shortRepo } from "../format.ts";
import type { FilterOptions, Filters } from "../filters.ts";
import { SearchIcon } from "./icons.tsx";

export function FilterBar({
	filters,
	options,
	org,
	viewer,
	shown,
	total,
	onChange,
}: {
	filters: Filters;
	options: FilterOptions;
	org: string;
	viewer: Viewer;
	shown: number;
	total: number;
	onChange(filters: Filters): void;
}) {
	const mine = new Set(viewer.teams.map((team) => team.slug));
	const teams = [...options.teams].sort((a, b) => Number(mine.has(b.slug)) - Number(mine.has(a.slug)));
	const hidden = total - shown;
	return (
		<form className="filters" role="search" aria-label="Filter the board" onSubmit={(event) => event.preventDefault()}>
			<label className="field field-search">
				<span className="sr-only">Search title, repository, number, or author</span>
				<SearchIcon size={14} />
				<input
					type="search"
					placeholder="Search title, repo, #number, author"
					value={filters.text}
					onChange={(event) => onChange({ ...filters, text: event.target.value })}
				/>
			</label>
			<Select label="Repository" value={filters.repo} all="All repositories" options={options.repos.map((repo) => ({ value: repo, label: shortRepo(repo, org) }))} onChange={(repo) => onChange({ ...filters, repo })} />
			{options.areas.length > 0 && (
				<Select label="Area" value={filters.area} all="All areas" options={options.areas.map((area) => ({ value: area, label: area }))} onChange={(area) => onChange({ ...filters, area })} />
			)}
			{teams.length > 0 && (
				<Select
					label="Team"
					value={filters.team}
					all="All teams"
					options={teams.map((team) => ({ value: team.slug, label: mine.has(team.slug) ? `${team.name} (yours)` : team.name }))}
					onChange={(team) => onChange({ ...filters, team })}
				/>
			)}
			<p className="filter-status" role="status">
				{hidden === 0 ? `${total} open on the board` : `${hidden} of ${total} hidden by filters`}
			</p>
			{isFiltering(filters) && (
				<button type="button" className="button button-quiet" onClick={() => onChange(NO_FILTERS)}>
					Clear filters
				</button>
			)}
		</form>
	);
}

function Select<T extends string>({
	label,
	value,
	all,
	options,
	onChange,
}: {
	label: string;
	value: T | null;
	all: string;
	options: { value: T; label: string }[];
	onChange(value: T | null): void;
}) {
	return (
		<label className="field">
			<span className="field-label">{label}</span>
			<select
				value={value ?? ""}
				onChange={(event) => onChange(options.find((option) => option.value === event.target.value)?.value ?? null)}
			>
				<option value="">{all}</option>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	);
}
