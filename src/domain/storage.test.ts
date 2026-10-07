import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createSampleLayout, parseLayout, serializeLayout, validateLayout } from './layout';
import { addWidget, updateWidgetSettings, widgetSources } from './widgets';
import { dashboardHeading } from './usage';
import { storageGeometry, storageRows, storageRowName, storageSample, storageShort, storageSize } from './storage';

function python(input: unknown, script: string) {
  return JSON.parse(execFileSync('python3', ['-c', script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, PYTHONPATH: 'runtime' } }));
}

describe('mounted filesystem widget', () => {
  it('round trips both designs and absent source with matching Python validation', () => {
    const doc = addWidget({ ...createSampleLayout(), widgets: [] }, 'mounted-storage');
    expect(widgetSources(doc.widgets[0])).toEqual(['sample', 'mounted-storage']);
    expect(dashboardHeading(doc)).toBe('Storage overview');
    for (const style of ['bars', 'table'] as const) for (const source of [undefined, 'sample', 'mounted-storage'] as const) {
      const changed = updateWidgetSettings(doc, 'mounted-storage', { style, ...(source ? { source } : {}) });
      if (!source && changed.widgets[0].type === 'storage') delete changed.widgets[0].settings.source;
      expect(parseLayout(serializeLayout(changed))).toEqual(changed);
      expect(python(changed, `import json,sys\nfrom turzx_studio.layout import validate_layout\nprint(json.dumps(validate_layout(json.load(sys.stdin))))`)).toEqual(changed);
    }
  });
  it('rejects sensor sources, unsupported styles, transient rows and missing settings', () => {
    const doc = addWidget({ ...createSampleLayout(), widgets: [] }, 'mounted-storage');
    for (const patch of [{ source: 'disk' }, { style: 'ring' }, { mounts: [] }, { source: null }]) {
      const bad = { ...doc, widgets: [{ ...doc.widgets[0], settings: { ...doc.widgets[0].settings, ...patch } }] };
      expect(() => validateLayout(bad)).toThrow();
      expect(python(bad, `import json,sys\nfrom turzx_studio.layout import validate_layout\ntry: validate_layout(json.load(sys.stdin)); print('true')\nexcept ValueError: print('false')`)).toBe(false);
    }
  });
  it('shares sample rows, capacity, truncation and size formatting with PIL', () => {
    const sizes = [0, 1.25, 999.95, 1024, 1062, -1, null];
    const dimensions = [[352, 480, 'bars'], [564, 384, 'table'], [200, 480, 'table'], [1, 1, 'bars'], [564, 160, 'bars']] as const;
    const expected = { sample: storageSample, geometry: dimensions.map(([w,h,s]) => storageGeometry(w,h,s)), sizes: sizes.map(storageSize), clipped: storageShort('/mnt/very-long-directory', 9) };
    expect(python({ sizes, dimensions }, `import json,sys\nfrom turzx_studio.storage_display import SAMPLE_STORAGE,storage_geometry,storage_size,storage_short\nd=json.load(sys.stdin)\nprint(json.dumps(dict(sample=SAMPLE_STORAGE,geometry=[storage_geometry(*args) for args in d['dimensions']],sizes=[storage_size(n) for n in d['sizes']],clipped=storage_short('/mnt/very-long-directory',9))))`)).toEqual(expected);
    expect(storageGeometry(352,480,'bars').capacity).toBe(5);
    expect(storageGeometry(564,384,'table').capacity).toBe(5);
  });
  it('groups physical drives and filters partition paths in order with Python parity', () => {
    const settings = [
      { label: 'Drives', style: 'bars', grouping: 'drives' },
      { label: 'Partitions', style: 'bars', grouping: 'partitions', mounts: ['/', '/mnt/nvme', '/mnt/games'] },
      { label: 'Aliases', style: 'bars', grouping: 'partitions', mounts: ['/home', '/', '/missing'] },
    ] as const;
    for (const input of settings) {
      const document = addWidget({ ...createSampleLayout(), widgets: [] }, 'mounted-storage');
      const next = updateWidgetSettings(document, 'mounted-storage', input.grouping === 'drives' ? { ...input } : { ...input, grouping: 'partitions' });
      const checked = next.widgets[0];
      if (checked.type !== 'storage') throw new Error('Missing storage');
      const rows = storageRows(checked.settings);
      expect(python(checked.settings, `import json,sys\nfrom turzx_studio.storage_display import SAMPLE_STORAGE,storage_rows,storage_row_name\ns=json.load(sys.stdin);r=storage_rows(s,SAMPLE_STORAGE)\nprint(json.dumps(dict(rows=r,names=[storage_row_name(i,'mounts' in s) for i in r])))`)).toEqual({ rows, names: rows.map((row) => storageRowName(row, Boolean(checked.settings.mounts))) });
      expect(python(next, `import json,sys\nfrom turzx_studio.layout import validate_layout\nprint(json.dumps(validate_layout(json.load(sys.stdin))))`)).toEqual(next);
      expect(parseLayout(serializeLayout(next))).toEqual(next);
    }
    expect(storageRows({ label: 'Drives', style: 'bars', grouping: 'drives' }).map((row) => row.mount)).toEqual(['SSD', 'NVMe', 'HDD']);
    expect(storageRows({ label: 'Missing', style: 'bars', mounts: ['/missing'] })[0].usedGiB).toBeNull();
  });
  it('rejects malformed filters and clears them when switching back to drives', () => {
    const doc = addWidget({ ...createSampleLayout(), widgets: [] }, 'mounted-storage');
    for (const patch of [{ grouping: 'bad' }, { grouping: 'drives', mounts: ['/'] }, { grouping: 'partitions', mounts: ['relative'] }, { grouping: 'partitions', mounts: ['/', '/'] }, { grouping: 'partitions', mounts: ['/\nsecret'] }, { grouping: 'partitions', mounts: Array.from({ length: 33 }, (_, i) => `/${i}`) }]) {
      expect(() => updateWidgetSettings(doc, 'mounted-storage', patch)).toThrow();
      const bad = { ...doc, widgets: [{ ...doc.widgets[0], settings: { ...doc.widgets[0].settings, ...patch } }] };
      expect(python(bad, `import json,sys\nfrom turzx_studio.layout import validate_layout\ntry: validate_layout(json.load(sys.stdin)); print('true')\nexcept ValueError: print('false')`)).toBe(false);
    }
    const filtered = updateWidgetSettings(doc, 'mounted-storage', { grouping: 'partitions', mounts: ['/', '/mnt/nvme'] });
    const cleared = updateWidgetSettings(filtered, 'mounted-storage', { grouping: 'drives', mounts: undefined });
    expect(cleared.widgets[0].settings).not.toHaveProperty('mounts');
  });
});
