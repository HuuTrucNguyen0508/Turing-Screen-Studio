import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { CardContent } from './WidgetContent';
import type { Widget } from './domain/layout';

export interface LibraryEntry {
  id: string;
  name: string;
  group: string;
  family: string;
  variant: string;
  description: string;
  widget: Widget;
}

interface LibraryGroup { id: string; name: string }
interface Family { id: string; name: string; entries: LibraryEntry[]; stageHeight: number }
interface Section { id: string; name: string; families: Family[]; count: number }

// One scale for every preview, so versions of a widget compare by size at a glance.
const SCALE = 3 / 8;
const MAX_WIDTH = 224, MAX_HEIGHT = 210;
const ALL = 'all';

function previewScale(widget: Widget): number {
  return Math.min(SCALE, MAX_WIDTH / widget.width, MAX_HEIGHT / widget.height);
}

function searchText(entry: LibraryEntry, groupName: string): string {
  return [entry.name, entry.family, entry.variant, entry.description, entry.id, entry.group, groupName].join(' ').toLowerCase();
}

// Prefer the Standard version's name. Otherwise use the longest name, which carries the most context ("CPU load gauge" over "Gauge").
function familyName(entries: readonly LibraryEntry[]): string {
  const standard = entries.find((entry) => entry.variant.toLowerCase() === 'standard');
  return standard?.name ?? entries.reduce((best, entry) => entry.name.length > best.length ? entry.name : best, '');
}

function buildSections(entries: readonly LibraryEntry[], groups: readonly LibraryGroup[]): Section[] {
  const order = [...groups];
  for (const entry of entries) if (!order.some((group) => group.id === entry.group)) order.push({ id: entry.group, name: entry.group });
  return order.map((group) => {
    const members = entries.filter((entry) => entry.group === group.id);
    const families = [...new Set(members.map((entry) => entry.family))].map((id) => {
      const versions = members.filter((entry) => entry.family === id)
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => a.entry.widget.width * a.entry.widget.height - b.entry.widget.width * b.entry.widget.height || a.index - b.index)
        .map(({ entry }) => entry);
      const stageHeight = Math.max(...versions.map((entry) => Math.round(entry.widget.height * previewScale(entry.widget))));
      return { id, name: familyName(versions), entries: versions, stageHeight };
    });
    return { id: group.id, name: group.name, families, count: members.length };
  }).filter((section) => section.count > 0);
}

function Specimen({ widget }: { widget: Widget }) {
  const scale = previewScale(widget);
  return <div className="library-specimen" style={{ width: Math.round(widget.width * scale), height: Math.round(widget.height * scale) }}>
    <div className="dashboard-card" style={{ left: 0, top: 0, width: widget.width, height: widget.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}><CardContent widget={widget} /></div>
  </div>;
}

export default function WidgetLibrary({ entries, groups, onAdd, onClose }: {
  entries: readonly LibraryEntry[];
  groups: readonly LibraryGroup[];
  onAdd: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [groupId, setGroupId] = useState<string>(ALL);
  const deferredQuery = useDeferredValue(query);
  const searchInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);

  const groupNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups]);
  const search = deferredQuery.trim().toLowerCase();
  const matches = useMemo(() => {
    const terms = search.split(/\s+/).filter(Boolean);
    return entries.filter((entry) => {
      const text = searchText(entry, groupNames.get(entry.group) ?? '');
      return terms.every((term) => text.includes(term));
    });
  }, [entries, groupNames, search]);
  const sections = useMemo(() => buildSections(matches, groups), [matches, groups]);
  const filterGroups = useMemo(() => buildSections(entries, groups).map(({ id, name }) => ({ id, name })), [entries, groups]);
  const visible = groupId === ALL ? sections : sections.filter((section) => section.id === groupId);
  const shown = visible.reduce((total, section) => total + section.count, 0);
  const exactScale = entries.every((entry) => previewScale(entry.widget) === SCALE);
  const activeGroupName = filterGroups.find((group) => group.id === groupId)?.name;

  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [groupId, search]);

  function clearSearch() { setQuery(''); searchInput.current?.focus(); }
  function searchKey(event: KeyboardEvent<HTMLInputElement>) {
    // The first Escape clears the search; the next one closes the dialog.
    if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); }
  }

  return <div className="widget-library">
    <header className="library-header">
      <div className="panel-heading">
        <div><h2 id="catalog-title">Add widget</h2><p className="library-lede">{exactScale ? 'Previews share one scale, so sizes compare directly.' : 'Choose a widget to place it on the canvas.'}</p></div>
        <button className="library-close" aria-label="Close widget catalog" onClick={onClose}>×</button>
      </div>
      <div className="library-search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>
        <input ref={searchInput} type="search" aria-label="Search widgets" placeholder="Search by name, source or size, such as cpu wide" value={query} autoComplete="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} onKeyDown={searchKey} />
        {query && <button className="library-clear" onClick={clearSearch}>Clear</button>}
      </div>
      <div className="library-filters" role="group" aria-label="Widget categories">
        <button aria-pressed={groupId === ALL} onClick={() => setGroupId(ALL)}>All widgets <span aria-hidden="true">{matches.length}</span></button>
        {filterGroups.map((group) => <button key={group.id} aria-pressed={groupId === group.id} onClick={() => setGroupId(group.id)}>
          {group.name} <span aria-hidden="true">{sections.find((section) => section.id === group.id)?.count ?? 0}</span>
        </button>)}
      </div>
      <p className="library-count mono" aria-live="polite">{shown === entries.length ? `Showing all ${shown} widgets` : `Showing ${shown} of ${entries.length} widgets`}</p>
    </header>
    <div className="library-body" ref={body}>
      {visible.map((section) => <section className="library-section" key={section.id} aria-labelledby={`library-${section.id}`}>
        <h3 className="eyebrow" id={`library-${section.id}`}>{section.name} <span>{section.count}</span></h3>
        <div className="library-families">
          {section.families.map((family) => <div className="library-family" key={family.id} style={{ '--stage-height': `${family.stageHeight}px` } as CSSProperties}>
            <div className="library-family-name"><strong>{family.name}</strong>{family.entries.length > 1 && <span className="mono">{family.entries.length} versions</span>}</div>
            <div className="library-variants">
              {family.entries.map((entry) => <button key={entry.id} className="library-tile" aria-label={`Add ${entry.name}`} onClick={() => onAdd(entry.id)}>
                <span className="library-stage" aria-hidden="true"><Specimen widget={entry.widget} /></span>
                <span className="library-tile-title"><strong>{entry.name}</strong><span className="library-variant">{entry.variant}</span></span>
                <span className="library-size mono">{entry.widget.width} × {entry.widget.height}</span>
                <span className="library-description">{entry.description}</span>
                <span className="library-add" aria-hidden="true">Add</span>
              </button>)}
            </div>
          </div>)}
        </div>
      </section>)}
      {shown === 0 && <div className="library-empty">
        <strong>{deferredQuery.trim() ? `No widgets match “${deferredQuery.trim()}”${activeGroupName ? ` in ${activeGroupName}` : ''}.` : 'This category has no widgets.'}</strong>
        <p>Try a source such as cpu or network, a size such as wide or compact, or a type such as gauge.</p>
        <div>
          {query && <button onClick={clearSearch}>Clear search</button>}
          {groupId !== ALL && <button onClick={() => setGroupId(ALL)}>Search all categories</button>}
        </div>
      </div>}
    </div>
  </div>;
}
