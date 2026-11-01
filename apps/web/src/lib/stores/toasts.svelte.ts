export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  message: string;
  detail?: string;
  kind: 'info' | 'success' | 'error';
  action?: ToastAction;
  /** 0..1 shows a progress bar. */
  progress?: number;
}

let nextId = 1;

class Toasts {
  items = $state<Toast[]>([]);
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  show(message: string, opts: Partial<Omit<Toast, 'id' | 'message'>> & { timeout?: number } = {}): number {
    const id = nextId++;
    const { timeout = 5000, ...rest } = opts;
    this.items.push({ id, message, kind: 'info', ...rest });
    if (timeout > 0) this.timers.set(id, setTimeout(() => this.dismiss(id), timeout));
    return id;
  }

  update(id: number, patch: Partial<Omit<Toast, 'id'>>): void {
    const t = this.items.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  }

  dismiss(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.items = this.items.filter((t) => t.id !== id);
  }

  error(message: string, detail?: string): number {
    return this.show(message, { kind: 'error', detail, timeout: 8000 });
  }
}

export const toasts = new Toasts();
