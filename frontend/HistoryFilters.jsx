import React from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@appica/ui-react/button';
import { Toggle } from '@appica/ui-react/toggle';
import { ToggleGroup } from '@appica/ui-react/toggle-group';
import { DatePicker } from '@appica/ui-react/date-picker';
import { Chip } from '@appica/ui-react/chip';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@appica/ui-react/dropdown-menu';
import { zhCN } from 'react-day-picker/locale';
import { ArrowDownWideNarrow, ChevronUp, SlidersHorizontal } from 'lucide-react';

// History filter controls. desktop.js owns the state (window.PicGenHistoryFilters shapes it) and
// re-renders this with new props; every change goes back through the callbacks.
//   #historyFilterControls  (toolbar row)  筛选 toggle + sort menu
//   #historyFilterPanel     (below it)     the collapsible panel, then the chips of what applies

const dayText = date => {
  if (!date) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const textDay = text => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || '');
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
};

function VendorMark({ icon }) {
  if (!icon) return null;
  return <img className="history-vendor-mark" src={`assets/model-icons/${icon}.svg`} alt="" aria-hidden="true" />;
}

// Base UI's Toggle swaps an empty `value` for a generated id, so 全部 ('') travels as 'all'.
const ALL = 'all';
function Segmented({ label, options, value, onChange, id }) {
  return <div className="history-filter-field">
    <span className="history-filter-label" id={`${id}Label`}>{label}</span>
    <ToggleGroup id={id} className="history-filter-segments" aria-labelledby={`${id}Label`} value={[value || ALL]}
      onValueChange={next => { const picked = next[0] ?? ALL; onChange(picked === ALL ? '' : picked); }}>
      {options.map(option => <Toggle key={option.id || ALL} value={option.id || ALL} size="sm" data-value={option.id || ALL}>{option.label}</Toggle>)}
    </ToggleGroup>
  </div>;
}

function FilterPanel({ catalog, filters, vendors, onChange }) {
  const set = patch => onChange({ ...filters, ...patch });
  const range = filters.date.preset === 'custom' ? { from: textDay(filters.date.from), to: textDay(filters.date.to) } : undefined;
  return <div id="historyFilterPanelBody" className="history-filter-panel-body">
    <div className="history-filter-field">
      <span className="history-filter-label" id="historyVendorFilterLabel">模型</span>
      <ToggleGroup id="historyVendorFilter" className="history-filter-segments" multiple aria-labelledby="historyVendorFilterLabel"
        value={filters.vendors} onValueChange={next => set({ vendors: next })}>
        {vendors.map(vendor => <Toggle key={vendor.id} value={vendor.id} size="sm" data-value={vendor.id} title={vendor.title || vendor.label}>
          <VendorMark icon={vendor.icon} />{vendor.label}<span className="history-filter-count">{vendor.count}</span>
        </Toggle>)}
      </ToggleGroup>
    </div>
    <div className="history-filter-stack">
      <Segmented id="historyDatePreset" label="日期" options={catalog.DATE_PRESETS} value={filters.date.preset}
        onChange={preset => set({ date: { preset, from: preset === 'custom' ? filters.date.from : '', to: preset === 'custom' ? filters.date.to : '' } })} />
      {filters.date.preset === 'custom' && <DatePicker id="historyDateRange" className="history-date-range" mode="range" size="sm" locale={zhCN}
        dateFormat="yyyy-MM-dd" value={range} defaultOpen={!filters.date.from && !filters.date.to} triggerAriaLabel="选择日期范围"
        disabledDates={{ after: new Date() }}
        onValueChange={value => set({ date: { preset: 'custom', from: dayText(value?.from), to: dayText(value?.to) } })} />}
    </div>
    <Segmented id="historyUsageFilter" label="使用" options={catalog.USAGES} value={filters.usage} onChange={usage => set({ usage })} />
  </div>;
}

export function HistoryFilters(props) {
  const { catalog, filters, sort, sortHidden, expanded, vendors, onChange, onSortChange, onExpandedChange, onClear, onRemoveChip } = props;
  const chips = catalog.describe(filters);
  const active = catalog.activeCount(filters);
  const panelHost = document.getElementById('historyFilterPanel');
  const sortLabel = catalog.SORTS.find(item => item.id === sort)?.label || '最新';
  const controls = <div className="history-filter-controls">
    <Button id="historyFilterToggle" type="button" size="sm" variant={expanded || active ? 'soft' : 'ghost'}
      aria-expanded={expanded} aria-controls="historyFilterPanelBody" title={expanded ? '收起筛选' : '展开筛选'}
      onClick={() => onExpandedChange(!expanded)}>
      <SlidersHorizontal aria-hidden="true" /><span>筛选</span>{active > 0 && <span className="history-filter-badge">{active}</span>}
    </Button>
    {!sortHidden && <DropdownMenu>
      <DropdownMenuTrigger render={<Button id="historySortButton" type="button" size="sm" variant="ghost" title={`排序：${sortLabel}`} aria-label={`排序：${sortLabel}`} />}>
        <ArrowDownWideNarrow aria-hidden="true" /><span className="history-sort-label">{sortLabel}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={sort} onValueChange={onSortChange}>
          {catalog.SORTS.map(item => <DropdownMenuRadioItem key={item.id} value={item.id} data-sort={item.id} closeOnClick>{item.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>}
  </div>;
  const panel = <>
    {expanded && <div className="history-filter-panel">
      <FilterPanel catalog={catalog} filters={filters} vendors={vendors} onChange={onChange} />
      <Button type="button" size="sm" variant="ghost" className="history-filter-collapse" title="收起筛选" aria-label="收起筛选" onClick={() => onExpandedChange(false)}>
        <ChevronUp aria-hidden="true" />
      </Button>
    </div>}
    {chips.length > 0 && <div id="historyFilterChips" className="history-filter-chips" role="status">
      {chips.map(chip => <Chip key={`${chip.kind}:${chip.value}`} size="sm" dismissible closeLabel={`去掉${chip.label}`} title={chip.title || chip.label}
        data-chip={`${chip.kind}:${chip.value}`} open onOpenChange={open => { if (!open) onRemoveChip(chip); }}>
        {chip.icon ? <VendorMark icon={chip.icon} /> : null}{chip.label}
      </Chip>)}
      <Button id="historyClearFiltersBtn" type="button" size="sm" variant="ghost" onClick={onClear}>清除全部</Button>
    </div>}
  </>;
  return <>
    {controls}
    {panelHost ? createPortal(panel, panelHost) : null}
  </>;
}
