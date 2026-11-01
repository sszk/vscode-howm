import { dateString } from "./core";

// One visibility-scoped minute timer shared by Todo and On This Day.
export class LocalDayClock {
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private today: string;

  constructor(private clock: () => string = dateString) {
    this.today = clock();
  }

  watch(listener: () => void) {
    this.listeners.add(listener);
    if (!this.timer) this.timer = setInterval(() => this.checkDate(), 60_000);
    this.checkDate();
    return {
      dispose: () => {
        this.listeners.delete(listener);
        if (!this.listeners.size) this.dispose();
      },
    };
  }

  checkDate() {
    const today = this.clock();
    if (today === this.today) return;
    this.today = today;
    for (const listener of this.listeners) listener();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }
}
