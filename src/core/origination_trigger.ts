import type { ThufirConfig } from './config.js';
import type { TaSnapshot } from './ta_surface.js';
import type { NormalizedEvent } from '../events/types.js';

export type TriggerReason = 'cadence' | 'ta_alert' | 'event';

export interface TriggerResult {
  fire: boolean;
  reason: TriggerReason;
  alertedSymbols: string[];
}

export class OriginationTrigger {
  private readonly cadenceMs: number;

  constructor(config: ThufirConfig) {
    const cadenceMinutes = config.autonomy?.origination?.cadenceMinutes ?? 15;
    this.cadenceMs = cadenceMinutes * 60 * 1000;
  }

  shouldFire(
    lastFiredMs: number,
    taSnapshots: TaSnapshot[],
    pendingEvents: NormalizedEvent[]
  ): TriggerResult {
    // Priority 1: TA alert
    const alertedSymbols = taSnapshots
      .filter((s) => s.alertReason !== undefined)
      .map((s) => s.symbol);

    if (alertedSymbols.length > 0) {
      return { fire: true, reason: 'ta_alert', alertedSymbols };
    }

    // Priority 2: New event since last fired
    const hasNewEvent = pendingEvents.some(
      (e) => new Date(e.createdAt).getTime() > lastFiredMs
    );

    if (hasNewEvent) {
      return { fire: true, reason: 'event', alertedSymbols: [] };
    }

    // Priority 3: Cadence
    if (Date.now() - lastFiredMs >= this.cadenceMs) {
      return { fire: true, reason: 'cadence', alertedSymbols: [] };
    }

    return { fire: false, reason: 'cadence', alertedSymbols: [] };
  }
}
