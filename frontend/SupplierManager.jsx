import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@appica/ui-react/button';
import { Input } from '@appica/ui-react/input';
import { Textarea } from '@appica/ui-react/textarea';
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  LayoutGrid,
  MessagesSquare,
  Plus,
  Save,
  ScanSearch,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  emptyRow,
  mergeDiscoveredModels,
  readModelRows,
  rowsFromGroup,
  validateGroupCapacity,
  validateSupplierIdentity,
} from './supplierDraft.mjs';

const toast = (message, kind) => (window.showToast || window.PicGenAppica?.showToast)?.(message, kind);

// 供应商图标库：从中挑选一个 lucide 图标作为供应商标识（取代手填图标名）。
const SUPPLIER_ICON_LIBRARY = [
  'building-2', 'server', 'cloud', 'cpu', 'bot', 'sparkles', 'brain', 'zap',
  'image', 'palette', 'wand-2', 'aperture', 'camera', 'layers', 'shapes', 'box',
  'boxes', 'database', 'globe', 'hexagon', 'orbit', 'atom', 'flame', 'gem',
  'rocket', 'component', 'feather', 'infinity',
];

// 供应商官网跳转目标：优先 website（缺协议补 https），否则退回 baseUrl 的 origin。
function resolveWebsiteUrl(supplier) {
  const website = String(supplier?.website || '').trim();
  if (website) return /^https?:\/\//i.test(website) ? website : `https://${website}`;
  const base = String(supplier?.baseUrl || '').trim();
  if (!base) return '';
  try { return new URL(/^https?:\/\//i.test(base) ? base : `https://${base}`).origin; } catch { return ''; }
}

function openWebsite(supplier) {
  const url = resolveWebsiteUrl(supplier);
  if (url) window.picgenDesktop?.openExternal?.(url);
}

// 折叠卡片的挂载生命周期：展开即挂载；收起时高度动画（grid-template-rows）跑完后再卸载
// ——但卸载（React 拆子树 + 桥接 select 同步销毁）很重，若直接在 transitionend 里同步做，
// 会正好卡在收起到"一条横线"那一帧上，肉眼可见地顿一下。因此把卸载推到动画完成之后的
// 两个 rAF（此时已无动画在跑，主线程忙一下也不掉帧）；再展开会取消待执行的卸载。
function useCollapse(expanded, delay = 360) {
  const [mounted, setMounted] = useState(expanded);
  const timer = useRef(null);
  const raf1 = useRef(0);
  const raf2 = useRef(0);
  const cancel = () => {
    clearTimeout(timer.current);
    cancelAnimationFrame(raf1.current);
    cancelAnimationFrame(raf2.current);
  };
  const scheduleUnmount = () => {
    cancel();
    raf1.current = requestAnimationFrame(() => {
      raf2.current = requestAnimationFrame(() => setMounted(false));
    });
  };
  useEffect(() => {
    if (expanded) { cancel(); setMounted(true); }
    else if (mounted) { timer.current = setTimeout(scheduleUnmount, delay); } // 兜底：transitionend 漏了也能收
    return cancel;
  }, [expanded]);
  const onTransitionEnd = event => {
    if (event.propertyName === 'grid-template-rows' && !expanded) scheduleUnmount();
  };
  return { mounted, onTransitionEnd };
}

// Supplier icons are lucide names: the wrapper owns the <i> markup so React
// never reconciles the <svg> lucide swaps in, and each instance re-runs the
// icon pass on its own node whenever the name changes. lucide.createIcons is the
// real global (window.refreshLucideIcons is not exported), scoped to the node.
function LucideName({ name, className = '' }) {
  const ref = useRef(null);
  const safe = String(name || 'building-2').replace(/[^a-z0-9-]/gi, '') || 'building-2';
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    window.lucide?.createIcons?.({ root: node });
    // lucide 1.34 生成的 svg 保留 data-lucide，会被后续任何 createIcons 扫描再次
    // replaceChild 重建（图标闪一下）。转换完成后摘掉该属性，使刷新幂等。
    node.querySelectorAll('svg[data-lucide]').forEach(svg => svg.removeAttribute('data-lucide'));
  }, [safe]);
  return <span ref={ref} className={`unified-supplier-lucide ${className}`} aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: `<i data-lucide="${safe}"></i>` }} />;
}

// Native <select> stays the scriptable source of truth; the select bridge mounts
// the Appica face beside it (same hybrid used across the app).
function BridgedSelect({ id, label, value, onChange, disabled = false, className = '', children }) {
  const ref = useRef(null);
  useEffect(() => {
    const wrapper = ref.current;
    if (!wrapper || !window.PicGenAppica) return undefined;
    window.PicGenAppica.mountSelects(wrapper, label ? { [id]: label } : {});
    return () => queueMicrotask(() => window.PicGenAppica?.disposeSelects?.(wrapper));
  }, [id, label]);
  return (
    <div ref={ref} className="modern-select appica-select-field" data-select-id={id}>
      <select id={id} className={className} value={value} onChange={onChange} disabled={disabled}>{children}</select>
      <div className="appica-select-host" />
    </div>
  );
}

async function compressIconFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const side = Math.min(width, height);
  const size = Math.min(1024, Math.max(1, side));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d').drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
  return { dataUrl: canvas.toDataURL('image/webp', 0.82), size };
}

function roleGroupsOf(supplier, role) {
  const groups = supplier?.groups || [];
  return role === 'chat' ? groups.filter(group => group.role === 'chat') : groups.filter(group => group.role !== 'chat');
}

const roleName = role => (role === 'chat' ? '对话' : '生图');

// Displayed address: explicit website, else the baseUrl host, else raw baseUrl.
function displayAddress(supplier) {
  const website = String(supplier?.website || '').trim();
  if (website) return website.replace(/^https?:\/\//, '');
  const base = String(supplier?.baseUrl || '').trim();
  if (!base) return '未设置地址';
  try { return new URL(base).host; } catch { return base.replace(/^https?:\/\//, ''); }
}

// Aggregate the health of a supplier's groups into one status dot. Health is
// keyed by group id (image-role providers); groups without a rating are ignored.
// Disabled groups are excluded — a manually stopped group is "off", not "failed".
function aggregateHealth(supplier, health) {
  const ratings = (supplier?.groups || [])
    .filter(group => group?.enabled !== false)
    .map(group => health?.[group.id]?.rating)
    .filter(Boolean);
  if (!ratings.length) return { key: 'unknown', label: '未知' };
  if (ratings.every(rating => rating === 'available')) return { key: 'available', label: '可用' };
  if (ratings.every(rating => rating === 'failed')) return { key: 'failed', label: '故障' };
  return { key: 'degraded', label: '部分可用' };
}

const UNIFIED_ICONS = { image: ImageIcon, chat: MessagesSquare };

function SupplierOverviewCard({ supplier, health, selected, onDelete }) {
  const imageModels = roleGroupsOf(supplier, 'image').reduce((total, group) => total + (group.models?.length || 0), 0);
  const chatModels = roleGroupsOf(supplier, 'chat').reduce((total, group) => total + (group.models?.length || 0), 0);
  const status = aggregateHealth(supplier, health);
  return (
    <article className="unified-supplier-card" data-supplier-id={supplier.id} data-selected={selected || undefined}>
      <div className="unified-supplier-overview">
        <span className="unified-supplier-icon-badge">
          {supplier.iconImage
            ? <img className="unified-supplier-icon-image" src={supplier.iconImage} alt="" />
            : <LucideName name={supplier.icon} />}
        </span>
        <div className="unified-supplier-identity">
          <strong>{supplier.name || '未命名供应商'}</strong>
          {resolveWebsiteUrl(supplier)
            ? <button type="button" className="unified-supplier-address is-link" title="打开官网"
                onClick={event => { event.stopPropagation(); openWebsite(supplier); }}>
                <span className="unified-supplier-address-text">{displayAddress(supplier)}</span><ExternalLink size={11} />
              </button>
            : <span className="unified-supplier-address">{displayAddress(supplier)}</span>}
          <div className="unified-supplier-meta">
            <span className="unified-supplier-stats">生图 {imageModels} · 对话 {chatModels}</span>
            <span className={`unified-health-dot health-${status.key}`} title={`近期状态：${status.label}`}>
              <i /> {status.label}
            </span>
          </div>
        </div>
        <div className="unified-supplier-card-actions">
          <button type="button" className="icon-button danger-button" title="删除供应商" onClick={onDelete}><Trash2 size={15} /></button>
        </div>
      </div>
    </article>
  );
}

function IconEditorFields({ icon, iconImage, onIcon, onIconImage }) {
  const fileRef = useRef(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  async function handleUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const { dataUrl, size } = await compressIconFile(file);
      onIconImage(dataUrl);
      toast(`图标已压缩为 ${size}×${size}`);
    } catch {
      toast('图标上传失败，请选择有效图片', 'error');
    }
  }
  // 从图标库选一个：设为 lucide 图标名，并清掉已上传图片（图标即以此为准）。
  function pickLibraryIcon(name) {
    onIcon(name);
    onIconImage('');
    setLibraryOpen(false);
  }
  return (
    <label className="full-field unified-supplier-icon-field">
      <span>供应商图标</span>
      <div className="unified-supplier-icon-editor">
        <span className="unified-supplier-icon-drop is-preview" aria-hidden="true">
          {iconImage ? <img className="unified-supplier-icon-image" src={iconImage} alt="" /> : <LucideName name={icon} />}
        </span>
        <div className="unified-supplier-icon-controls">
          <div className="unified-supplier-icon-buttons">
            <Button variant="outline" size="sm" type="button" onClick={() => fileRef.current?.click()}>
              <Upload size={13} />{iconImage ? '更换图片' : '上传图片'}
            </Button>
            <Button variant="outline" size="sm" type="button" aria-expanded={libraryOpen}
              onClick={() => setLibraryOpen(open => !open)}>
              <LayoutGrid size={13} />从图标库选择
            </Button>
            {iconImage && <Button variant="ghost" size="sm" type="button" onClick={() => onIconImage('')}>移除</Button>}
          </div>
          {libraryOpen && (
            <div className="unified-supplier-icon-library" role="listbox" aria-label="选择供应商图标">
              {SUPPLIER_ICON_LIBRARY.map(name => (
                <button type="button" key={name} title={name} aria-label={name}
                  className={`unified-icon-option${!iconImage && icon === name ? ' is-active' : ''}`}
                  aria-selected={!iconImage && icon === name} onClick={() => pickLibraryIcon(name)}>
                  <LucideName name={name} />
                </button>
              ))}
            </div>
          )}
        </div>
        <input ref={fileRef} id="unifiedSupplierIconFileInput" type="file" hidden
          accept="image/png,image/jpeg,image/webp,image/avif" onChange={handleUpload} />
      </div>
    </label>
  );
}

// Supplier identity form (shared name/website/baseUrl/icon). Used both for
// editing an existing supplier and creating a new one (with its first group).
function IdentityForm({ mode, supplier, protocols, defaultPrompt, actions, onClose, onSaved, persistent = false, identityOpen = true, onToggleIdentity }) {
  const isNew = mode === 'new-supplier';
  const [name, setName] = useState(supplier?.name || '');
  const [website, setWebsite] = useState(supplier?.website || '');
  const [baseUrl, setBaseUrl] = useState(supplier?.baseUrl || '');
  const [icon, setIcon] = useState(supplier?.icon || 'building-2');
  const [iconImage, setIconImage] = useState(supplier?.iconImage || '');
  // Called unconditionally to satisfy the rules of hooks; only used when isNew.
  const group = useGroupDraft(null, 'image', defaultPrompt);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // 折叠状态由父级 SupplierManager 持有并通过 props 传入（默认展开），因此切换供应商
  // 导致本卡片按 key 重挂载时不会重置，保持之前的开/合。不并入 group 的单开模型。
  const { mounted, onTransitionEnd } = useCollapse(persistent && identityOpen);

  async function handleSave() {
    if (busyRef.current) return;
    let identity;
    let groupPayload = null;
    try {
      validateSupplierIdentity({ name, baseUrl });
      identity = { name: name.trim(), website: website.trim(), baseUrl: baseUrl.trim(), icon: icon.trim() || 'building-2', iconImage };
      if (isNew) groupPayload = group.buildPayload();
    } catch (error) {
      toast(error.message);
      if (error.rowIndex != null) group?.focusRow(error.rowIndex, error.field);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const saved = isNew
        ? await actions.createSupplier({ ...identity, groups: [groupPayload] })
        : await actions.updateSupplier(supplier.id, identity);
      onSaved?.(saved);
    } catch { /* action layer surfaced it; keep draft open */ } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const formBody = (
    <>
      <div className="unified-inline-grid">
        <label>
          <span>供应商名称</span>
          <Input inputSize="sm" id="unifiedSupplierNameInput" type="text" placeholder="例如 Fzl" autoFocus={!persistent}
            value={name} onChange={event => setName(event.target.value)} />
        </label>
        <label>
          <span>官网</span>
          <Input inputSize="sm" id="unifiedSupplierWebsiteInput" type="text" placeholder="留空则显示接口域名"
            value={website} onChange={event => setWebsite(event.target.value)} />
        </label>
        <label className="full-field">
          <span>Base URL（接口地址，配置组共用）</span>
          <Input inputSize="sm" id="unifiedSupplierBaseUrlInput" type="text" placeholder="https://api.example.com"
            value={baseUrl} onChange={event => setBaseUrl(event.target.value)} />
        </label>
      </div>
      <IconEditorFields icon={icon} iconImage={iconImage} onIcon={setIcon} onIconImage={setIconImage} />
      {isNew && <GroupFields draft={group} protocols={protocols} baseUrl={baseUrl} actions={actions} />}
      <div className="unified-editor-actions">
        <span className="unified-editor-actions-spacer" />
        {/* New-supplier form keeps unifiedDrawerSave (it renders alone). The
            persistent identity form coexists with an open group card, so it needs
            its own id to avoid a duplicate-id collision with the group's save. */}
        <Button id={isNew ? 'unifiedDrawerSave' : 'unifiedIdentitySave'} variant="primary" size="sm" type="button" disabled={busy} onClick={handleSave}>
          <Save size={14} />{busy ? '保存中…' : (isNew ? '创建供应商' : '保存供应商')}
        </Button>
      </div>
    </>
  );

  // 供应商信息卡片：折叠形态与配置组卡一致（摘要行 + grid-template-rows 动画 + 展开挂载）。
  if (persistent) {
    const address = displayAddress({ website, baseUrl });
    return (
      <section className={`unified-group-card unified-identity-collapse${identityOpen ? ' is-open' : ''}`} data-editor="identity">
        <div className="unified-group-card-summary">
          <button type="button" className="unified-group-summary-main" aria-expanded={identityOpen} onClick={() => onToggleIdentity?.(!identityOpen)}>
            <span className="unified-group-icon unified-identity-icon">
              {iconImage ? <img className="unified-supplier-icon-image" src={iconImage} alt="" /> : <LucideName name={icon} />}
            </span>
            <span className="unified-group-copy">
              <strong>供应商信息</strong>
              <small>{name || '未命名供应商'}{address ? ` · ${address}` : ''}</small>
            </span>
          </button>
          <button type="button" className="unified-group-chevron-btn" aria-label={identityOpen ? '收起' : '展开'} onClick={() => onToggleIdentity?.(!identityOpen)}>
            <ChevronDown size={16} className="unified-group-chevron" />
          </button>
        </div>
        <div className="unified-group-card-body-wrap" data-open={identityOpen || undefined} onTransitionEnd={onTransitionEnd}>
          {mounted && <div className="unified-group-card-body">{formBody}</div>}
        </div>
      </section>
    );
  }

  return (
    <section className="unified-editor-card unified-identity-card" data-editor="new-supplier">
      <header className="unified-editor-card-head">
        <strong>新增供应商</strong>
        <button type="button" id="unifiedDrawerClose" className="icon-button" title="收起" onClick={onClose}><ChevronDown size={16} /></button>
      </header>
      {formBody}
    </section>
  );
}

// Shared group-draft state + validation, used by IdentityForm's first group and
// by GroupCard's editor. Keeps the smoke-driven DOM ids on the mounted form.
function useGroupDraft(group, role, defaultPrompt) {
  const formRef = useRef(null);
  const [initialRows] = useState(() => rowsFromGroup(group));
  const [rows, setRows] = useState(initialRows);
  const [activeKey, setActiveKey] = useState(() => {
    const preferred = group?.activeModel || group?.model || '';
    return (initialRows.find(row => row.name === preferred) || initialRows[0])?.key || '';
  });
  const [groupName, setGroupName] = useState(group?.name || '');
  const [apiKey, setApiKey] = useState(group?.apiKey || '');
  const [groupRole, setGroupRole] = useState(group?.role || role || 'image');
  const [maxConcurrent, setMaxConcurrent] = useState(String(group?.maxConcurrent || 1));
  const [priority, setPriority] = useState(String(group?.priority || 1));
  const [enabled, setEnabled] = useState(group?.enabled !== false);
  const [prompt, setPrompt] = useState(group?.promptOptimizerSystemPrompt || defaultPrompt);
  const [discovered, setDiscovered] = useState(() => mergeDiscoveredModels(group?.discoveredModels || [], []));

  const rowNames = rows.map(row => row.name.trim()).filter(Boolean);
  const uniqueNames = [...new Set(rowNames)];
  const activeRow = rows.find(row => row.key === activeKey) || null;
  const activeName = activeRow?.name.trim() || uniqueNames[0] || '';
  // Latest rows for event handlers whose closures could otherwise go stale
  // between rapid edits (a bridged select change resolving a name to its row).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  function selectActiveByName(name) {
    const target = rowsRef.current.find(row => row.name.trim() === name);
    if (target) setActiveKey(target.key);
  }

  function focusRow(index, field) {
    const selector = field === 'price' ? '.unified-model-price' : '.unified-model-name';
    formRef.current?.querySelectorAll(selector)?.[index]?.focus();
  }
  function buildPayload() {
    const draft = readModelRows(rows, { validate: true, activeModel: activeName });
    validateGroupCapacity({ role: groupRole, maxConcurrent });
    // `enabled` is intentionally omitted: it's controlled by the card switch
    // (immediate save), so the server merge preserves it here.
    return {
      name: groupName.trim() || (groupRole === 'chat' ? '反推配置组' : '生图配置组'),
      role: groupRole, apiKey: apiKey.trim(), ...draft,
      maxConcurrent: Number(maxConcurrent),
      priority: Math.max(1, Math.min(100, Number(priority) || 1)),
      promptOptimizerSystemPrompt: prompt.trim(), discoveredModels: discovered,
    };
  }

  return {
    formRef, rows, setRows, activeKey, setActiveKey, groupName, setGroupName, apiKey, setApiKey,
    groupRole, setGroupRole, maxConcurrent, setMaxConcurrent, priority, setPriority, enabled, setEnabled,
    prompt, setPrompt, discovered, setDiscovered, rowNames, uniqueNames, activeRow, activeName,
    focusRow, buildPayload, selectActiveByName,
  };
}

// The group-editing form body (fields + models + other settings). `draft` comes
// from useGroupDraft; `actions` provides test/discover; baseUrl for draft test.
function GroupFields({ draft, protocols, baseUrl, actions }) {
  const [busy, setBusy] = useState('');
  const [connection, setConnection] = useState(null);
  const {
    formRef, rows, setRows, activeKey, setActiveKey, groupName, setGroupName, apiKey, setApiKey,
    groupRole, setGroupRole, maxConcurrent, setMaxConcurrent, priority, setPriority, enabled, setEnabled,
    prompt, setPrompt, discovered, setDiscovered, rowNames, uniqueNames, activeRow, activeName,
    selectActiveByName,
  } = draft;
  const availableDiscovered = discovered.filter(item => !rowNames.includes(item.id));

  function updateRow(key, patch) { setRows(rows.map(row => (row.key === key ? { ...row, ...patch } : row))); }
  function removeRow(key) {
    const remaining = rows.filter(row => row.key !== key);
    const next = remaining.length ? remaining : [emptyRow()];
    if (key === activeKey) setActiveKey(next[0].key);
    setRows(next);
  }
  function appendModel(model = '') {
    const row = emptyRow(model);
    if (model && rows.length === 1 && !rows[0].name.trim()) {
      if (rows[0].key === activeKey) setActiveKey(row.key);
      setRows([row]);
    } else setRows([...rows, row]);
    return row;
  }

  async function handleTest() {
    if (busy) return;
    if (!baseUrl?.trim()) { toast('请先填写 Base URL'); return; }
    setBusy('test');
    setConnection({ pending: true, message: '测试中…' });
    try {
      const result = await actions.testDraft({
        baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: activeName,
        protocol: activeRow?.protocol || rows.find(row => row.name.trim())?.protocol || 'auto', role: groupRole,
      });
      const ok = result?.success !== false;
      const message = ok ? `连接成功${result?.latencyMs ? ` · ${result.latencyMs}ms` : ''}` : (result?.message || '连接失败');
      setConnection({ ok, message });
      toast(message, ok ? 'success' : 'error');
    } catch (error) {
      setConnection({ ok: false, message: error.message });
      toast(`连接测试失败：${error.message}`, 'error');
    } finally { setBusy(''); }
  }

  async function handleDiscover() {
    if (busy) return;
    if (!baseUrl?.trim()) { toast('请先填写 Base URL'); return; }
    setBusy('discover');
    try {
      const result = await actions.discoverDraft({
        baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: activeName, protocol: activeRow?.protocol || 'auto',
      });
      const found = Array.isArray(result?.models) ? result.models : [];
      // 覆盖而非追加：每次发现即以本次结果为准（换 baseUrl/apiKey 后旧发现结果已失效），
      // 用空 existing 走同一套归一化/去重。
      if (found.length) { setDiscovered(mergeDiscoveredModels([], found)); toast(`已发现 ${found.length} 个模型`, 'success'); }
      else toast('未发现可用模型');
    } catch (error) { toast(`发现模型失败：${error.message}`, 'error'); } finally { setBusy(''); }
  }

  return (
    <div className="unified-group-editor" id="unifiedGroupEditor" ref={formRef}>
      <div className="unified-inline-grid">
        <label>
          <span>模型组命名</span>
          <Input inputSize="sm" id="unifiedGroupNameInput" type="text" placeholder="例如 A-1"
            value={groupName} onChange={event => setGroupName(event.target.value)} />
        </label>
        <label className="full-field">
          <span>API Key</span>
          <Input inputSize="sm" id="unifiedGroupApiKeyInput" type="password" placeholder="sk-..."
            value={apiKey} onChange={event => setApiKey(event.target.value)} />
        </label>
      </div>

      <div className="unified-group-connection-actions" role="group" aria-label="配置组连接操作">
        <Button id="unifiedGroupTestBtn" variant="outline" size="sm" type="button" disabled={!!busy} onClick={handleTest}>
          <Activity size={14} />{busy === 'test' ? '测试中…' : '测试连接'}
        </Button>
        <Button id="unifiedGroupDiscoverBtn" variant="outline" size="sm" type="button" disabled={!!busy} onClick={handleDiscover}>
          <ScanSearch size={14} />{busy === 'discover' ? '发现中…' : '发现模型'}
        </Button>
        {connection && (
          <span className="unified-connection-status" data-ok={connection.ok === true ? 'true' : connection.pending ? 'pending' : 'false'}>
            {connection.message}
          </span>
        )}
      </div>

      <label id="unifiedDiscoveredModelField" className="full-field" hidden={!discovered.length}>
        <span>已发现模型</span>
        <BridgedSelect id="unifiedDiscoveredModelSelect" label="已发现模型" value=""
          disabled={!availableDiscovered.length}
          onChange={event => { if (event.target.value) appendModel(event.target.value); }}>
          <option value="">{availableDiscovered.length ? '选择已发现模型' : '已全部添加'}</option>
          {availableDiscovered.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}
        </BridgedSelect>
      </label>

      <div className="unified-model-editor">
        <div className="unified-model-editor-head">
          <div><strong>模型</strong><span>每个模型单独一行，可设置单次价格和请求格式</span></div>
          <Button id="unifiedAddModelBtn" variant="outline" size="sm" type="button" onClick={() => appendModel()}>
            <Plus size={14} />新增模型
          </Button>
        </div>
        <div className="unified-model-grid-head" aria-hidden="true"><span>模型名称</span><span>价格/张</span><span>请求格式</span><span></span></div>
        <div id="unifiedGroupModelsRows" className="unified-model-rows">
          {rows.map(row => (
            <div className="unified-model-row" key={row.key}>
              <input type="text" className="unified-model-name" placeholder="模型名称" aria-label="模型名称"
                value={row.name} onChange={event => updateRow(row.key, { name: event.target.value })} />
              <input type="number" min="0" step="any" className="unified-model-price" placeholder="可选" aria-label="模型单张价格"
                value={row.price} onChange={event => updateRow(row.key, { price: event.target.value })} />
              <BridgedSelect id={`unifiedModelProtocol_${row.key}`} label="模型请求格式" className="unified-model-protocol"
                value={row.protocol} onChange={event => updateRow(row.key, { protocol: event.target.value })}>
                {(protocols.some(([value]) => value === row.protocol) ? protocols : [...protocols, [row.protocol, row.protocol]])
                  .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </BridgedSelect>
              <button type="button" className="icon-button danger-button" title="删除模型" aria-label="删除模型"
                onClick={() => removeRow(row.key)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      </div>

      <div className="unified-other-settings">
        <div className="unified-model-editor-head"><div><strong>其他设置</strong><span>默认模型、排序与并发容量</span></div></div>
        <div className="unified-inline-grid">
          <label>
            <span>默认模型</span>
            <BridgedSelect id="unifiedGroupActiveModelInput" label="默认模型" value={activeName} disabled={!uniqueNames.length}
              onChange={event => selectActiveByName(event.target.value)}>
              {uniqueNames.length ? uniqueNames.map(model => <option key={model} value={model}>{model}</option>) : <option value="">先添加模型</option>}
            </BridgedSelect>
          </label>
          <label>
            <span>用途</span>
            <BridgedSelect id="unifiedGroupRoleSelect" label="用途" value={groupRole} onChange={event => setGroupRole(event.target.value)}>
              <option value="image">生图</option>
              <option value="chat">反推 / 提示词优化</option>
            </BridgedSelect>
          </label>
          {groupRole === 'image' && (
            <label id="unifiedGroupConcurrencyField">
              <span>最大并发</span>
              <Input inputSize="sm" id="unifiedGroupConcurrencyInput" type="number" min="1" max="8" step="1"
                value={maxConcurrent} onChange={event => setMaxConcurrent(event.target.value)} />
            </label>
          )}
          <label id="unifiedGroupPriorityField">
            <span>排序优先级（1 最优先）</span>
            <Input inputSize="sm" id="unifiedGroupPriorityInput" type="number" min="1" max="100" step="1"
              value={priority} onChange={event => setPriority(event.target.value)} />
          </label>
        </div>
      </div>
    </div>
  );
}

// A collapsible group card: summary row when collapsed, full editor when open.
function GroupCard({ supplier, group, health, protocols, defaultPrompt, expanded, onToggle, actions, onSaved, onToggleEnabled }) {
  const draft = useGroupDraft(group, group.role, defaultPrompt);
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const enabled = group.enabled !== false;
  // Body stays mounted through the collapse transition (so both directions animate
  // via CSS grid-template-rows), then unmounts to keep the scriptable ids unique.
  // useCollapse defers that unmount off the animation's final frame — the teardown
  // (React subtree + base-ui Select disposal) was the end-of-collapse hitch when it
  // ran synchronously at transitionend. base-ui Collapsible would fight the nested
  // Select popups, so the height animation stays plain CSS.
  const { mounted, onTransitionEnd: handleWrapTransitionEnd } = useCollapse(expanded);
  const RoleIcon = UNIFIED_ICONS[group.role === 'chat' ? 'chat' : 'image'];
  const rating = health?.[group.id]?.rating;
  const statusKey = enabled ? (rating || 'unknown') : 'off';
  const statusLabel = !enabled ? '已停用' : rating === 'available' ? '可用' : rating === 'degraded' ? '降级' : rating === 'failed' ? '故障' : '未知';

  async function handleSave() {
    if (busyRef.current) return;
    let payload;
    try { payload = draft.buildPayload(); }
    catch (error) { toast(error.message); if (error.rowIndex != null) draft.focusRow(error.rowIndex, error.field); return; }
    busyRef.current = true; setBusy('save');
    try { const saved = await actions.saveGroup(supplier.id, group.id, payload); onSaved?.(saved, group.id); }
    catch { /* surfaced */ } finally { busyRef.current = false; setBusy(''); }
  }
  async function handleDelete() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy('delete');
    try { if (await actions.deleteGroup(supplier.id, group.id)) onToggle(false); }
    finally { busyRef.current = false; setBusy(''); }
  }

  return (
    <section className={`unified-group-card${expanded ? ' is-open' : ''}${enabled ? '' : ' is-disabled'}`} data-group-id={group.id} data-role={group.role}>
      <div className="unified-group-card-summary">
        <button type="button" className="unified-group-summary-main" onClick={() => onToggle(!expanded)} aria-expanded={expanded}>
          <span className="unified-group-icon"><RoleIcon size={15} /></span>
          <span className="unified-group-copy">
            <strong>{group.name || (group.role === 'chat' ? '反推配置组' : '生图配置组')}</strong>
            <small>{roleName(group.role)} · {(group.models || []).length} 个模型 · {group.activeModel || group.model || '未设默认'}</small>
          </span>
        </button>
        <button type="button" id={`unifiedGroupCardEnabled_${group.id}`} className={`unified-group-switch${enabled ? ' is-on' : ''}`}
          role="switch" aria-checked={enabled} aria-label={enabled ? '停用此配置组' : '启用此配置组'} title={enabled ? '已启用，点击停用' : '已停用，点击启用'}
          onClick={() => onToggleEnabled(group, !enabled)}><span className="unified-group-switch-knob" /></button>
        <span className={`unified-health-dot health-${statusKey}`} title={`状态：${statusLabel}`}><i /></span>
        <button type="button" className="unified-group-chevron-btn" aria-label={expanded ? '收起' : '展开'} onClick={() => onToggle(!expanded)}>
          <ChevronDown size={16} className="unified-group-chevron" />
        </button>
      </div>
      <div className="unified-group-card-body-wrap" data-open={expanded || undefined} onTransitionEnd={handleWrapTransitionEnd}>
        {mounted && (
          <div className="unified-group-card-body">
            <GroupFields draft={draft} protocols={protocols} baseUrl={supplier.baseUrl} actions={actions} />
            <div className="unified-editor-actions">
              <Button id="unifiedGroupDelete" variant="destructive" size="sm" type="button" disabled={!!busy} onClick={handleDelete}>
                <Trash2 size={14} />删除配置组
              </Button>
              <span className="unified-editor-actions-spacer" />
              <Button id="unifiedDrawerSave" variant="primary" size="sm" type="button" disabled={!!busy} onClick={handleSave}>
                <Save size={14} />{busy === 'save' ? '保存中…' : '保存配置组'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export function SupplierManager({ suppliers = [], startIndex = 0, protocols = [], defaultPrompt = '', health = {}, onSelect, actions }) {
  const clampIndex = index => Math.max(0, Math.min(index, Math.max(0, suppliers.length - 1)));
  const [selected, setSelected] = useState(clampIndex(startIndex));
  // Below-the-carousel expansion: a group id, 'identity', 'new-supplier', or null.
  const [expanded, setExpanded] = useState(null);
  // 供应商信息卡的折叠状态提升到此处（而非 IdentityForm 内部），这样带 key 的身份表单
  // 随供应商切换重挂载时不会被重置——切换供应商保持之前的开/合状态。
  const [identityOpen, setIdentityOpen] = useState(true);
  const trackRef = useRef(null);
  const wheelHostRef = useRef(null);
  const selectedRef = useRef(clampIndex(startIndex));
  selectedRef.current = clampIndex(selected);

  const index = clampIndex(selected);
  const supplier = suppliers[index] || null;

  useEffect(() => {
    const next = clampIndex(startIndex);
    setSelected(next);
  }, [startIndex, suppliers.length]);

  // 不做 host 级 lucide 全表刷新：lucide 1.34 的 createIcons 非幂等（生成的 svg 仍带
  // data-lucide，会被再次命中并 replaceChild 重建），每次渲染全表扫会让供应商图标
  // 拆了重建、肉眼可见地闪。LucideName 自己按 [safe] 转换即可，无需外层兜底。

  useEffect(() => {
    const openNew = () => { setExpanded('new-supplier'); };
    const closePanel = () => setExpanded(null);
    window.addEventListener('picgen:open-new-supplier', openNew);
    window.addEventListener('picgen:close-supplier-panel', closePanel);
    return () => {
      window.removeEventListener('picgen:open-new-supplier', openNew);
      window.removeEventListener('picgen:close-supplier-panel', closePanel);
    };
  }, []);

  function moveTo(next) {
    const target = clampIndex(next);
    if (target === selectedRef.current) return;
    setSelected(target);
    // Switching supplier: collapse any per-supplier editor except new-supplier
    // (which is independent of the selected card), then follow the new supplier.
    setExpanded(current => (current === 'new-supplier' ? current : null));
    onSelect?.(target);
  }
  function moveBy(delta) { moveTo(selectedRef.current + delta); }

  // Snap wheel: each notch advances one supplier; holding a continuous scroll
  // fires repeatedly (throttled) for fast switching. Stops at both edges.
  useEffect(() => {
    const node = wheelHostRef.current;
    if (!node || suppliers.length < 2) return undefined;
    let cooldown = false;
    const onWheel = event => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      if (cooldown || Math.abs(event.deltaY) < 4) return;
      cooldown = true;
      moveBy(event.deltaY > 0 ? 1 : -1);
      setTimeout(() => { cooldown = false; }, 110);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [suppliers.length]);

  function handleSavedIdentity(saved) {
    if (expanded === 'new-supplier') { setExpanded(null); return; }
  }
  async function handleDeleteSupplier(target) {
    if (await actions.deleteSupplier(target)) setExpanded(null);
  }
  function handleSavedGroup(saved, groupId) {
    // Follow the group to its (possibly changed) role; keep it expanded.
    const savedGroups = saved?.groups || [];
    const target = savedGroups.find(item => item.id === groupId) || savedGroups[savedGroups.length - 1];
    if (target?.id) setExpanded(target.id);
  }
  function handleToggleGroupEnabled(group, next) {
    actions.setGroupEnabled(supplier.id, group.id, next);
  }

  if (!suppliers.length) {
    return (
      <div className="supplier-manager">
        <div className="unified-supplier-empty"><LucideName name="server" /><span>还没有统一供应商，点击下方按钮新增</span></div>
        <div className="unified-supplier-footer">
          <Button id="unifiedNewSupplierBtn" variant="primary" size="sm" type="button" onClick={() => setExpanded(current => (current === 'new-supplier' ? null : 'new-supplier'))}>
            <Plus size={14} />新增供应商
          </Button>
        </div>
        {expanded === 'new-supplier' && (
          <section id="unifiedInlineEditor" className="unified-supplier-below">
            <IdentityForm mode="new-supplier" supplier={null} protocols={protocols} defaultPrompt={defaultPrompt}
              actions={actions} onClose={() => setExpanded(null)} onSaved={handleSavedIdentity} />
          </section>
        )}
      </div>
    );
  }

  const imageGroups = roleGroupsOf(supplier, 'image');
  const chatGroups = roleGroupsOf(supplier, 'chat');
  const orderedGroups = [...imageGroups, ...chatGroups];

  return (
    <div className="supplier-manager">
      <div className="supplier-carousel-frame">
        {/* New supplier: a black + at the top-right, above the next-switch nav. */}
        <button id="unifiedNewSupplierBtn" type="button" className="supplier-add-btn" title="新增供应商" aria-label="新增供应商"
          onClick={() => setExpanded(current => (current === 'new-supplier' ? null : 'new-supplier'))}><Plus size={16} /></button>
        <div className="supplier-carousel" ref={wheelHostRef}>
          {suppliers.length > 1 && (
            <button type="button" className="supplier-carousel-nav supplier-carousel-prev" aria-label="上一个供应商"
              disabled={index === 0} onClick={() => moveBy(-1)}><ChevronLeft size={16} /></button>
          )}
          <div className="supplier-carousel-viewport">
            <div className="supplier-carousel-track" ref={trackRef}
              style={{ transform: `translateX(-${index * 100}%)` }}>
              {suppliers.map(item => (
                <div className="supplier-carousel-slide" key={item.id}>
                  <SupplierOverviewCard supplier={item} health={health} selected={item === supplier}
                    onDelete={() => handleDeleteSupplier(item)} />
                </div>
              ))}
            </div>
          </div>
          {suppliers.length > 1 && (
            <button type="button" className="supplier-carousel-nav supplier-carousel-next" aria-label="下一个供应商"
              disabled={index === suppliers.length - 1} onClick={() => moveBy(1)}><ChevronRight size={16} /></button>
          )}
        </div>
      </div>
      {suppliers.length > 1 && (
        <div className="supplier-carousel-dots" role="tablist" aria-label="供应商">
          {suppliers.map((item, dotIndex) => (
            <button key={item.id} type="button" className={`supplier-carousel-dot${dotIndex === index ? ' is-active' : ''}`}
              aria-label={`第 ${dotIndex + 1} 个`} aria-selected={dotIndex === index} onClick={() => moveTo(dotIndex)} />
          ))}
        </div>
      )}
      <div className="supplier-carousel-counter">{index + 1} / {suppliers.length}</div>

      <section id="unifiedInlineEditor" className="unified-supplier-below">
        {expanded === 'new-supplier' ? (
          <IdentityForm key="new-supplier" mode="new-supplier" supplier={null} protocols={protocols}
            defaultPrompt={defaultPrompt} actions={actions} onClose={() => setExpanded(null)} onSaved={handleSavedIdentity} />
        ) : (
          <>
            {/* Supplier identity (name / website / baseUrl / icon) as a collapsible
                card for the current supplier — collapsed by default, expand to edit. */}
            <IdentityForm key={`identity:${supplier.id}`} mode="supplier" supplier={supplier} protocols={protocols}
              defaultPrompt={defaultPrompt} actions={actions} persistent onSaved={handleSavedIdentity}
              identityOpen={identityOpen} onToggleIdentity={setIdentityOpen} />

            <div className="unified-group-list">
              {orderedGroups.map(group => (
                <GroupCard key={group.id} supplier={supplier} group={group} health={health} protocols={protocols}
                  defaultPrompt={defaultPrompt} expanded={expanded === group.id}
                  onToggle={open => setExpanded(open ? group.id : null)} actions={actions}
                  onSaved={handleSavedGroup} onToggleEnabled={handleToggleGroupEnabled} />
              ))}
              {!orderedGroups.length && <p className="unified-group-empty">该供应商还没有配置组</p>}
            </div>

            {String(expanded).startsWith('new-group:') && (
              <NewGroupCard key={expanded} supplier={supplier} protocols={protocols} defaultPrompt={defaultPrompt}
                actions={actions} onClose={() => setExpanded(null)} onSaved={handleSavedGroup} />
            )}

            <div className="unified-supplier-footer">
              <Button variant="outline" size="sm" type="button"
                onClick={() => setExpanded(current => (String(current).startsWith('new-group:') ? null : `new-group:${supplier.id}:${Date.now()}`))}>
                <Plus size={14} />新增配置组
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// A fresh (unsaved) group editor appended below, for "新增配置组".
function NewGroupCard({ supplier, protocols, defaultPrompt, actions, onClose, onSaved }) {
  const draft = useGroupDraft(null, 'image', defaultPrompt);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  async function handleSave() {
    if (busyRef.current) return;
    let payload;
    try { payload = draft.buildPayload(); }
    catch (error) { toast(error.message); if (error.rowIndex != null) draft.focusRow(error.rowIndex, error.field); return; }
    busyRef.current = true; setBusy(true);
    try { const saved = await actions.saveGroup(supplier.id, null, payload); onSaved?.(saved, null); }
    catch { /* surfaced */ } finally { busyRef.current = false; setBusy(false); }
  }
  return (
    <section className="unified-editor-card" data-editor="new-group">
      <header className="unified-editor-card-head">
        <strong>新增配置组 · {supplier.name || ''}</strong>
        <button type="button" id="unifiedDrawerClose" className="icon-button" title="收起" onClick={onClose}><ChevronDown size={16} /></button>
      </header>
      <GroupFields draft={draft} protocols={protocols} baseUrl={supplier.baseUrl} actions={actions} />
      <div className="unified-editor-actions">
        <span className="unified-editor-actions-spacer" />
        <Button id="unifiedDrawerSave" variant="primary" size="sm" type="button" disabled={busy} onClick={handleSave}>
          <Save size={14} />{busy ? '保存中…' : '保存配置组'}
        </Button>
      </div>
    </section>
  );
}
