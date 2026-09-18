import { h, Component } from 'preact';
import type SnackBarElement from 'shared/custom-els/snack-bar';
import { zip } from 'fflate';

import WorkerBridge from '../worker-bridge';
import { decodeImage, compressImage } from '../image-pipeline';
import { encoderMap, EncoderState, EncoderType } from '../feature-meta';
import Select from '../Compress/Options/Select';
import LocaleSelect from 'shared/i18n/LocaleSelect';
import { t } from 'shared/i18n';

type ItemStatus = 'queued' | 'decoding' | 'encoding' | 'done' | 'error';

/** Codecs whose wasm build is multithreaded (they call checkThreadsSupport). */
const THREADED_CODECS: ReadonlySet<string> = new Set([
  'avif',
  'jxl',
  'wp2',
  'oxiPNG',
]);

const DEFAULT_ENCODER: EncoderType = 'mozJPEG';
const DEFAULT_CONCURRENCY = 4;
const CONCURRENCY_CHOICES = [1, 2, 4, 6, 8, 12];
const CPU_CHOICES = [25, 50, 75, 100];
const DEFAULT_CPU_PERCENT = 50;

interface BatchItem {
  file: File;
  status: ItemStatus;
  result?: File;
  url?: string;
  error?: string;
}

interface Props {
  files: File[];
  onBack(): void;
  showSnack: SnackBarElement['showSnackbar'];
}

interface State {
  encoderTypes: EncoderType[];
  encoderState: EncoderState;
  concurrency: number;
  cpuPercent: number;
  items: BatchItem[];
  running: boolean;
  /** Encoding settings changed since the current results were produced. */
  settingsDirty: boolean;
  exporting: boolean;
  exportDirName?: string;
  importMenuOpen: boolean;
}

function cores(): number {
  return navigator.hardwareConcurrency || 4;
}

/**
 * Splits the CPU budget across the parallel slots. Threaded codecs also get a
 * per-worker thread cap, injected through the worker URL.
 */
function planWork(threaded: boolean, cpuPercent: number, concurrency: number) {
  const budget = Math.max(1, Math.round((cores() * cpuPercent) / 100));
  if (!threaded) return { budget, threadsPerWorker: 1 };
  return {
    budget,
    threadsPerWorker: Math.max(1, Math.floor(budget / Math.max(1, concurrency))),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function ratioLabel(original: number, encoded: number): string {
  if (!original) return '—';
  return `${Math.round((encoded / original) * 100)}%`;
}

function itemKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|avif|jxl|qoi|bmp|gif)$/i;

function isImage(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSIONS.test(file.name);
}

function makeItems(files: File[]): BatchItem[] {
  return files.map((file) => ({ file, status: 'queued' as const }));
}

function uniqueName(entries: Record<string, unknown>, name: string): string {
  if (!(name in entries)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? '' : name.slice(dot);
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!(candidate in entries)) return candidate;
  }
}

function directoryPicker(): ((opts: unknown) => Promise<any>) | undefined {
  return (window as any).showDirectoryPicker;
}

/** Outcome of asking for an export folder. */
type PickResult = 'native' | 'browser' | 'cancelled' | 'unavailable';

/**
 * Batch mode: several images encoded across a pool of workers.
 *
 * Each worker gets its own `WorkerBridge`, which is what makes the pool
 * actually parallel — a single bridge serialises everything onto one worker.
 * Encoding never starts on its own: settings are chosen first, then the run is
 * started (and can be stopped) explicitly.
 */
export default class Batch extends Component<Props, State> {
  /** Bumped whenever a run is superseded, so stale work can bail out. */
  private runId = 0;
  private fileInput?: HTMLInputElement;
  private exportDir?: any;
  private exportMode: 'none' | 'native' | 'browser' = 'none';

  state: State = {
    encoderTypes: [DEFAULT_ENCODER],
    encoderState: {
      type: DEFAULT_ENCODER,
      options: encoderMap[DEFAULT_ENCODER].meta.defaultOptions,
    } as EncoderState,
    concurrency: DEFAULT_CONCURRENCY,
    cpuPercent: DEFAULT_CPU_PERCENT,
    items: makeItems(this.props.files),
    running: false,
    // Nothing runs until the user asks, so the result is stale from the start.
    settingsDirty: true,
    exporting: false,
    importMenuOpen: false,
  };

  componentDidMount() {
    this.resolveAvailableEncoders().then((encoderTypes) => {
      this.setState({ encoderTypes });
    });
  }

  componentWillUnmount() {
    this.runId++;
    this.revokeUrls(this.state.items);
  }

  componentDidUpdate(prevProps: Props) {
    if (prevProps.files === this.props.files) return;
    // Files dropped while this screen is open start a fresh batch.
    this.importFiles(this.props.files);
  }

  private async resolveAvailableEncoders(): Promise<EncoderType[]> {
    const entries = await Promise.all(
      (Object.keys(encoderMap) as EncoderType[]).map(async (type) => {
        const entry = encoderMap[type] as {
          featureTest?: () => Promise<boolean>;
        };
        if (entry.featureTest && !(await entry.featureTest())) return undefined;
        return type;
      }),
    );
    const available = entries.filter(Boolean) as EncoderType[];
    return available.length ? available : [DEFAULT_ENCODER];
  }

  private revokeUrls(items: BatchItem[]) {
    for (const item of items) {
      if (item.url) URL.revokeObjectURL(item.url);
    }
  }

  /**
   * The codec Options components are styled against custom properties that the
   * editor defines on `.compress` / `.options-scroller`. Without them the
   * labels inherit the page's dark text and vanish against the dark panels.
   */
  private setSidebar = (el: HTMLElement | null) => {
    if (!el) return;
    el.style.setProperty('--main-theme-color', 'var(--pink)');
    el.style.setProperty('--header-text-color', 'var(--white)');
    el.style.setProperty('--horizontal-padding', '15px');
  };

  /**
   * While nothing has been processed yet the list only grows, so images can be
   * gathered from several folders before a run starts. Once a run has produced
   * (or started producing) results, importing starts a fresh batch rather than
   * mixing new files in with old results.
   */
  private importFiles = (files: File[]) => {
    if (!files.length) return;

    const allPending = this.state.items.every(
      (item) => item.status === 'queued',
    );

    if (!allPending) {
      this.runId++;
      this.revokeUrls(this.state.items);
      this.setState({
        items: makeItems(files),
        running: false,
        settingsDirty: true,
        importMenuOpen: false,
      });
      return;
    }

    this.setState(({ items }) => {
      const known = new Set(items.map((item) => itemKey(item.file)));
      const additions = files
        .filter((file) => !known.has(itemKey(file)))
        .map((file) => ({ file, status: 'queued' as const }));
      return {
        items: additions.length ? [...items, ...additions] : items,
        importMenuOpen: false,
      };
    });
  };

  private toggleImportMenu = (event: Event) => {
    event.stopPropagation();
    const open = !this.state.importMenuOpen;
    this.setState({ importMenuOpen: open });
    if (!open) return;
    const close = () => {
      this.setState({ importMenuOpen: false });
      document.removeEventListener('click', close);
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  };

  private onPickImagesClick = () => {
    this.setState({ importMenuOpen: false });
    this.fileInput!.click();
  };

  private onFileInputChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.files) this.importFiles(Array.from(input.files));
    input.value = '';
  };

  private onPickFolderClick = async () => {
    this.setState({ importMenuOpen: false });
    const picker = directoryPicker();
    if (!picker) return;
    try {
      const dir = await picker({ mode: 'read' });
      const files: File[] = [];
      for await (const handle of (dir as any).values()) {
        if (handle.kind !== 'file') continue;
        const file: File = await handle.getFile();
        if (isImage(file)) files.push(file);
      }
      files.sort((a, b) => a.name.localeCompare(b.name));
      if (files.length) {
        this.importFiles(files);
      } else {
        this.props.showSnack(t('batch.noImagesInFolder'));
      }
    } catch {
      // Cancelled — not an error.
    }
  };

  private startRun = (resetAll: boolean) => () => {
    this.runId++;
    const runId = this.runId;

    if (resetAll) this.revokeUrls(this.state.items);

    const { encoderState, concurrency, cpuPercent, items } = this.state;
    const pending = resetAll
      ? makeItems(items.map((item) => item.file))
      : items.map((item) =>
          item.status === 'done' || item.status === 'error'
            ? item
            : { ...item, status: 'queued' as const },
        );
    const files = pending.map((item) => item.file);

    const threaded = THREADED_CODECS.has(encoderState.type as string);
    const { threadsPerWorker } = planWork(threaded, cpuPercent, concurrency);

    this.setState(
      { items: pending, running: true, settingsDirty: false },
      () =>
        this.runPool(runId, files, encoderState, concurrency, threadsPerWorker),
    );
  };

  private stopRun = () => {
    this.runId++;
    this.setState(({ items }) => ({
      running: false,
      items: items.map((item) =>
        item.status === 'done' || item.status === 'error'
          ? item
          : { ...item, status: 'queued' as const },
      ),
    }));
  };

  private async runPool(
    runId: number,
    files: File[],
    encoderState: EncoderState,
    concurrency: number,
    threadsPerWorker: number,
  ) {
    const pool = Array.from(
      { length: Math.max(1, concurrency) },
      () => new WorkerBridge(threadsPerWorker),
    );

    let cursor = 0;

    const worker = async (bridge: WorkerBridge) => {
      while (runId === this.runId) {
        const index = cursor++;
        if (index >= files.length) return;
        await this.processOne(runId, index, files[index], bridge, encoderState);
      }
    };

    await Promise.all(pool.map((bridge) => worker(bridge)));

    if (runId === this.runId) this.setState({ running: false });
  }

  private updateItem(index: number, patch: Partial<BatchItem>) {
    this.setState(({ items }) => ({
      items: items.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    }));
  }

  private async processOne(
    runId: number,
    index: number,
    file: File,
    bridge: WorkerBridge,
    encoderState: EncoderState,
  ) {
    const signal = new AbortController().signal;

    try {
      this.updateItem(index, { status: 'decoding' });
      const imageData = await decodeImage(signal, file, bridge);
      if (runId !== this.runId) return;

      this.updateItem(index, { status: 'encoding' });
      const result = await compressImage(
        signal,
        imageData,
        encoderState,
        file.name,
        bridge,
      );
      if (runId !== this.runId) return;

      this.updateItem(index, {
        status: 'done',
        result,
        url: URL.createObjectURL(result),
      });
    } catch (err) {
      if (runId !== this.runId) return;
      this.updateItem(index, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private onEncoderTypeChange = (event: Event) => {
    const type = (event.currentTarget as HTMLSelectElement).value as EncoderType;
    this.setState({
      encoderState: {
        type,
        options: encoderMap[type].meta.defaultOptions,
      } as EncoderState,
      settingsDirty: true,
    });
  };

  private onEncoderOptionsChange = (options: unknown) => {
    this.setState(({ encoderState }) => ({
      encoderState: { ...encoderState, options } as EncoderState,
      settingsDirty: true,
    }));
  };

  private onConcurrencyChange = (event: Event) => {
    this.setState({
      concurrency: Number((event.currentTarget as HTMLSelectElement).value),
      settingsDirty: true,
    });
  };

  private onCpuChange = (event: Event) => {
    this.setState({
      cpuPercent: Number((event.currentTarget as HTMLSelectElement).value),
      settingsDirty: true,
    });
  };

  /**
   * Asks the desktop shell for a folder first — that gives a native dialog and
   * a real path. Falls back to the browser's File System Access API, and
   * reports when neither is available so the caller can offer a ZIP instead.
   */
  private pickExportDir = async (): Promise<PickResult> => {
    try {
      const res = await fetch('/__pick-folder');
      if (res.status === 404 || res.status === 501) return 'unavailable';
      if (!res.ok) return 'unavailable';
      const path = (await res.text()).trim();
      if (!path) return 'cancelled';
      this.exportMode = 'native';
      this.setState({ exportDirName: path });
      return 'native';
    } catch {
      // Not running inside the desktop shell — try the browser API below.
    }

    const picker = directoryPicker();
    if (!picker) return 'unavailable';
    try {
      const handle = await picker({ mode: 'readwrite' });
      this.exportMode = 'browser';
      this.exportDir = handle;
      this.setState({ exportDirName: handle.name });
      return 'browser';
    } catch {
      return 'cancelled';
    }
  };

  private exportViaShell = async (items: BatchItem[]) => {
    for (const item of items) {
      const res = await fetch(
        `/__write?name=${encodeURIComponent(item.result!.name)}`,
        { method: 'POST', body: item.result! },
      );
      if (!res.ok) throw new Error('write failed');
    }
  };

  private exportViaBrowser = async (items: BatchItem[]) => {
    for (const item of items) {
      const fileHandle = await this.exportDir.getFileHandle(item.result!.name, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(item.result!);
      await writable.close();
    }
  };

  private onExportClick = async () => {
    const completed = this.state.items.filter(
      (item) => item.status === 'done' && item.result,
    );
    if (!completed.length) {
      this.props.showSnack(t('batch.nothingToExport'));
      return;
    }

    let mode = this.exportMode;
    if (mode === 'none') {
      const picked = await this.pickExportDir();
      if (picked === 'cancelled') return;
      if (picked === 'unavailable') {
        this.props.showSnack(t('batch.zipFallback'));
        await this.downloadZip();
        return;
      }
      mode = picked;
    }

    this.setState({ exporting: true });
    try {
      if (mode === 'native') {
        await this.exportViaShell(completed);
      } else {
        await this.exportViaBrowser(completed);
      }
      this.props.showSnack(
        t('batch.exported', {
          count: completed.length,
          dir: this.state.exportDirName || '',
        }),
      );
    } catch {
      this.props.showSnack(t('batch.exportFailed'));
    } finally {
      this.setState({ exporting: false });
    }
  };

  private onPathClick = () => {
    this.pickExportDir();
  };

  private downloadZip = async () => {
    const completed = this.state.items.filter(
      (item) => item.status === 'done' && item.result,
    );

    this.setState({ exporting: true });
    try {
      const entries: Record<string, Uint8Array> = {};
      for (const item of completed) {
        const name = uniqueName(entries, item.result!.name);
        entries[name] = new Uint8Array(await item.result!.arrayBuffer());
      }

      // Images are already compressed, so store without deflating.
      const data = await new Promise<Uint8Array>((resolve, reject) => {
        zip(entries, { level: 0 }, (err, out) =>
          err ? reject(err) : resolve(out),
        );
      });

      const url = URL.createObjectURL(
        new Blob([data], { type: 'application/zip' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'squoosh-batch.zip';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      this.props.showSnack(t('batch.zipFailed'));
    } finally {
      this.setState({ exporting: false });
    }
  };

  private statusLabel(item: BatchItem): string {
    switch (item.status) {
      case 'queued':
        return t('batch.status.queued');
      case 'decoding':
        return t('batch.status.decoding');
      case 'encoding':
        return t('batch.status.encoding');
      case 'done':
        return t('batch.status.done');
      case 'error':
        return item.error || t('batch.status.error');
    }
  }

  render() {
    const {
      items,
      encoderState,
      encoderTypes,
      concurrency,
      cpuPercent,
      running,
      settingsDirty,
      exporting,
      exportDirName,
      importMenuOpen,
    } = this.state;

    const OptionsComponent = (
      encoderMap[encoderState.type] as { Options?: any }
    ).Options;

    const threaded = THREADED_CODECS.has(encoderState.type as string);
    const { budget, threadsPerWorker } = planWork(
      threaded,
      cpuPercent,
      concurrency,
    );

    const done = items.filter((item) => item.status === 'done');
    const failed = items.filter((item) => item.status === 'error').length;
    const pending = items.length - done.length - failed;
    const originalTotal = items.reduce((sum, item) => sum + item.file.size, 0);
    const encodedTotal = done.reduce(
      (sum, item) => sum + (item.result?.size || 0),
      0,
    );

    const canRun = !running && (settingsDirty || pending > 0);
    const canExport = !exporting && done.length > 0;

    return (
      <div style={styles.page}>
        <header style={styles.header}>
          <button
            style={styles.backButton}
            onClick={this.props.onBack}
            title={t('editor.back')}
          >
            ← {t('editor.back')}
          </button>
          <h1 style={styles.title}>{t('batch.title')}</h1>
          <div style={styles.headerSpacer} />
          <LocaleSelect />
        </header>

        <div style={styles.body}>
          <aside ref={this.setSidebar} style={styles.sidebar}>
            <label style={styles.field}>
              {t('batch.encoder')}
              <Select
                value={encoderState.type}
                onChange={this.onEncoderTypeChange}
              >
                {encoderTypes.map((type) => (
                  <option value={type}>{encoderMap[type].meta.label}</option>
                ))}
              </Select>
            </label>

            <label style={styles.field}>
              {t('batch.concurrency')}
              <Select
                value={String(concurrency)}
                onChange={this.onConcurrencyChange}
              >
                {CONCURRENCY_CHOICES.map((value) => (
                  <option value={String(value)}>{value}</option>
                ))}
              </Select>
            </label>

            <label style={styles.field}>
              {t('batch.cpuLimit')}
              <Select value={String(cpuPercent)} onChange={this.onCpuChange}>
                {CPU_CHOICES.map((value) => (
                  <option value={String(value)}>{value}%</option>
                ))}
              </Select>
            </label>

            <p style={styles.usage}>
              {threaded
                ? t('batch.usageThreaded', {
                    concurrency,
                    threads: threadsPerWorker,
                    cores: concurrency * threadsPerWorker,
                  })
                : t('batch.usageSingle', { concurrency, cores: budget })}
            </p>

            <div style={styles.actions}>
              <button
                style={{
                  ...styles.primaryButton,
                  ...(!canRun ? styles.buttonDisabled : null),
                }}
                disabled={!canRun}
                onClick={this.startRun(settingsDirty)}
              >
                {running
                  ? t('batch.running')
                  : settingsDirty
                  ? t('batch.run')
                  : t('batch.runPending', { count: pending })}
              </button>
              <button
                style={{
                  ...styles.secondaryButton,
                  ...(!running ? styles.buttonDisabled : null),
                }}
                disabled={!running}
                onClick={this.stopRun}
              >
                {t('batch.stop')}
              </button>
            </div>

            {OptionsComponent ? (
              <div style={styles.options}>
                <OptionsComponent
                  options={encoderState.options}
                  onChange={this.onEncoderOptionsChange}
                />
              </div>
            ) : null}
          </aside>

          <main style={styles.main}>
            <div style={styles.exportBar}>
              <button
                style={styles.pathBox}
                onClick={this.onPathClick}
                title={t('batch.chooseFolder')}
              >
                <span style={styles.pathLabel}>{t('batch.exportTo')}</span>
                <span style={styles.pathValue}>
                  {exportDirName || t('batch.noFolder')}
                </span>
              </button>
              <button
                style={{
                  ...styles.primaryButton,
                  ...styles.exportButton,
                  ...(!canExport ? styles.buttonDisabled : null),
                }}
                disabled={!canExport}
                onClick={this.onExportClick}
              >
                {exporting ? t('batch.exporting') : t('batch.export')}
              </button>

              <div style={styles.importWrap}>
                <button style={styles.importButton} onClick={this.toggleImportMenu}>
                  + {t('batch.import')}
                </button>
                {importMenuOpen ? (
                  <div style={styles.importMenu}>
                    <button
                      style={styles.importMenuItem}
                      onClick={this.onPickImagesClick}
                    >
                      {t('batch.pickImages')}
                    </button>
                    <button
                      style={styles.importMenuItem}
                      onClick={this.onPickFolderClick}
                    >
                      {t('batch.pickFolder')}
                    </button>
                  </div>
                ) : null}
                <input
                  ref={(el) => {
                    this.fileInput = el as HTMLInputElement;
                  }}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={this.onFileInputChange}
                />
              </div>
            </div>

            <div style={styles.summary}>
              <span>
                {t('batch.progress', { done: done.length, total: items.length })}
              </span>
              {failed ? (
                <span style={styles.failed}>
                  · {t('batch.failedCount', { count: failed })}
                </span>
              ) : null}
              <span>
                {t('batch.original')}: {formatBytes(originalTotal)}
              </span>
              <span>
                {t('batch.compressed')}: {formatBytes(encodedTotal)}
              </span>
              <span>
                {t('batch.ratio')}:{' '}
                {done.length ? ratioLabel(originalTotal, encodedTotal) : '—'}
              </span>
            </div>

            <ul style={styles.list}>
              {items.map((item, index) => (
                <li key={index} style={styles.row}>
                  <div style={styles.rowMain}>
                    <span style={styles.filename} title={item.file.name}>
                      {item.file.name}
                    </span>
                    <span style={styles.status} data-status={item.status}>
                      {this.statusLabel(item)}
                    </span>
                  </div>
                  <div style={styles.rowStats}>
                    <span>{formatBytes(item.file.size)}</span>
                    <span style={styles.arrow}>→</span>
                    <span>{item.result ? formatBytes(item.result.size) : '—'}</span>
                    <span style={styles.ratio}>
                      {item.result
                        ? ratioLabel(item.file.size, item.result.size)
                        : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </main>
        </div>
      </div>
    );
  }
}

const styles: Record<string, any> = {
  page: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    background: '#fff',
    color: '#1f1f1f',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 20px',
    borderBottom: '1px solid rgba(0,0,0,0.1)',
    flex: '0 0 auto',
  },
  backButton: {
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid rgba(0,0,0,0.15)',
    borderRadius: '6px',
    background: '#fff',
    padding: '6px 12px',
  },
  title: { fontSize: '20px', margin: 0 },
  headerSpacer: { flex: 1 },
  body: { flex: '1 1 auto', display: 'flex', minHeight: 0 },
  sidebar: {
    flex: '0 0 300px',
    width: '300px',
    boxSizing: 'border-box',
    overflowY: 'auto',
    padding: '16px',
    // Dark, matching the codec options panels rendered inside it.
    background: 'var(--off-black)',
    color: 'var(--white)',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    fontSize: '13px',
    marginBottom: '12px',
  },
  usage: {
    fontSize: '12px',
    opacity: 0.7,
    margin: '0 0 12px',
    lineHeight: 1.4,
  },
  actions: { display: 'flex', gap: '8px', marginBottom: '8px' },
  primaryButton: {
    font: 'inherit',
    cursor: 'pointer',
    border: 'none',
    borderRadius: '6px',
    background: 'var(--pink)',
    color: '#fff',
    padding: '8px 14px',
    flex: 1,
  },
  secondaryButton: {
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.35)',
    borderRadius: '6px',
    background: 'transparent',
    color: 'inherit',
    padding: '8px 14px',
  },
  buttonDisabled: { opacity: 0.45, cursor: 'default' },
  options: { marginTop: '12px', color: 'var(--white)' },
  main: {
    flex: '1 1 auto',
    minWidth: 0,
    overflowY: 'auto',
    padding: '0 20px 32px',
  },
  exportBar: {
    display: 'flex',
    gap: '8px',
    alignItems: 'stretch',
    padding: '14px 0 4px',
  },
  pathBox: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    textAlign: 'left',
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid rgba(0,0,0,0.2)',
    borderRadius: '6px',
    background: '#f7f7f7',
    padding: '8px 12px',
  },
  pathLabel: { fontSize: '12px', opacity: 0.6, flex: '0 0 auto' },
  pathValue: {
    fontSize: '13px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  exportButton: { flex: '0 0 auto', minWidth: '96px' },
  importWrap: { position: 'relative', flex: '0 0 auto' },
  importButton: {
    font: 'inherit',
    cursor: 'pointer',
    border: '1px dashed rgba(0,0,0,0.3)',
    borderRadius: '6px',
    background: '#fff',
    padding: '9px 14px',
    whiteSpace: 'nowrap',
  },
  importMenu: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    zIndex: 10,
    minWidth: '160px',
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
    border: '1px solid rgba(0,0,0,0.15)',
    borderRadius: '6px',
    boxShadow: '0 6px 20px rgba(0,0,0,0.15)',
    overflow: 'hidden',
  },
  importMenuItem: {
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    padding: '10px 14px',
  },
  summary: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '16px',
    fontSize: '13px',
    padding: '12px 0',
    borderBottom: '1px solid rgba(0,0,0,0.1)',
    marginBottom: '4px',
  },
  failed: { color: '#c0392b' },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    padding: '10px 4px',
    borderBottom: '1px solid rgba(0,0,0,0.06)',
    fontSize: '13px',
  },
  rowMain: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
  filename: {
    maxWidth: '32ch',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  status: { fontSize: '12px', opacity: 0.65 },
  rowStats: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontVariantNumeric: 'tabular-nums',
  },
  arrow: { opacity: 0.4 },
  ratio: { minWidth: '4ch', textAlign: 'right', opacity: 0.7 },
};
